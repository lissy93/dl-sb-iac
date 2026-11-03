import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@11.15.0?target=deno";
import { Monitor } from "../shared/monitor.ts";
import {
  listPayingSubscriptions,
  PAID_PLANS,
  PLAN_MAPPING,
} from "../shared/stripe.ts";

// === 1) Initialize Supabase ===
const DB_URL = Deno.env.get("DB_URL") || "";
const DB_KEY = Deno.env.get("DB_KEY") || "";
const supabase = createClient(DB_URL, DB_KEY, {
  global: { headers: { Authorization: `Bearer ${DB_KEY}` } },
});

// === 2) Initialize Stripe ===
const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-11-20.acacia" });

// Reports anything needing attention to GlitchTip, when GLITCHTIP_DSN is set
const monitor = new Monitor("stripe-webhook");

// === 3) Serve Webhook ===
serve(async (req: Request) => {
  if (!DB_URL || !DB_KEY || !stripeSecretKey || !webhookSecret) {
    return respError("Missing environment variables", 500);
  }

  let event: Stripe.Event | undefined;
  try {
    // Verify Stripe webhook signature
    const signature = req.headers.get("stripe-signature");
    if (!signature) return respError("Missing stripe-signature header", 400);

    const rawBody = await req.text();
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      logError("Webhook signature verification failed", err);
      await monitor.warn(
        "Stripe webhook signature check failed, check STRIPE_WEBHOOK_SECRET",
      );
      return respError("Invalid signature", 400);
    }
    logInfo(`Received ${event.type}`, { eventId: event.id });

    // Route based on event type
    switch (event.type) {
      case "invoice.paid":
        await handleSubscriptionUpdated(event);
        break;
      case "customer.subscription.created":
        await handleSubscriptionUpdated(event);
        break;
      case "invoice.payment_failed":
        await handlePaymentFailed(event);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event);
        break;

      default:
        logInfo(`Unhandled event type: ${event.type}`);
    }

    return respSuccess();
  } catch (err: any) {
    // A non-2xx makes Stripe retry, for up to 3 days
    logError("Webhook error:", err);
    await monitor.fail(err, { eventId: event?.id, eventType: event?.type });
    return respError(err.message || "Unknown error", 400);
  }
});

/**
 * Handles subscription updates & invoice payments
 */
async function handleSubscriptionUpdated(event: any) {
  const invoice = event.data.object as Stripe.Invoice;
  const userId = invoice.metadata?.user_id ||
    invoice.subscription_details?.metadata?.user_id;
  const billingReason = invoice.billing_reason;
  const totalAmount = invoice.total;

  if (!userId) {
    logError(`${event.type}: No user_id in subscription metadata`, { invoice });
    await monitor.warn(`${event.type} has no user_id, so no plan was changed`, {
      eventId: event.id,
      customer: invoice.customer,
    });
    return;
  }

  if (invoice?.status === "incomplete") {
    logInfo(`Incomplete subscription for user ${userId}, ignoring`);
    return;
  }

  // Always upgrade if the invoice is for a new subscription
  if (billingReason === "subscription_create") {
    logInfo(`New subscription created for user ${userId}, ensuring upgrade`);
    await updateBillingRecord(userId, invoice);
    sendEmail(userId, "subscription_created");
    return;
  }

  // Ensure `lines.data` exists before using it
  const hasOnlyProratedItems = invoice.lines?.data?.length
    ? invoice.lines.data.every((item: { proration: boolean }) =>
      item.proration === true
    )
    : false;

  // STRONG check for post-cancellation proration
  if (
    billingReason === "subscription_cycle" && totalAmount === 0 &&
    hasOnlyProratedItems
  ) {
    logInfo(`Ignoring post-cancellation proration invoice for user ${userId}`);
    return;
  }

  // Otherwise, always update billing record (err on the side of caution)
  logInfo(`Processing invoice for user ${userId}, reason: ${billingReason}`);
  await updateBillingRecord(userId, invoice);
  sendEmail(userId, "subscription_updated");
}

/**
 * Handles failed payments
 */
async function handlePaymentFailed(event: any) {
  const invoice = event.data.object as Stripe.Invoice;
  const subId = invoice.subscription;
  const userId = getUserIdFromInvoice(invoice);

  if (!subId || !userId) {
    logError("invoice.payment_failed: No subscription/user ID found", {
      invoice,
    });
    return;
  }

  await monitor.warn("A subscriber's payment failed", {
    userId,
    invoice: invoice.id,
    attempt: invoice.attempt_count,
    nextAttempt: invoice.next_payment_attempt,
  });
  sendEmail(userId, "payment_failed");
}

/**
 * Handles subscription cancellations
 */
async function handleSubscriptionDeleted(event: any) {
  const subscription = event.data.object as Stripe.Subscription;
  const userId = getUserId(null, subscription);

  if (!userId) {
    logError("customer.subscription.deleted: No user_id found in metadata", {
      subscription,
    });
    await monitor.warn(
      "Canceled subscription has no user_id, so no one was downgraded",
      {
        eventId: event.id,
        customer: subscription.customer,
      },
    );
    return;
  }

  // A customer with another paying subscription keeps that plan instead
  const [remaining] = await listPayingSubscriptions({
    customer: subscription.customer as string,
  });
  if (remaining) {
    await monitor.warn(
      "User canceled a subscription but still pays for another, so kept that plan",
      {
        userId,
        canceled: subscription.id,
        remaining: remaining.id,
      },
    );
    await updateBillingRecord(userId, remaining);
    return;
  }

  await downgradeToFreePlan(userId);
  sendEmail(userId, "subscription_canceled");
}

/**
 * Upserts a billing record in Supabase
 */
async function updateBillingRecord(userId: string, eventObject: any) {
  let items = [];

  // 1️⃣ Check if the event object is an invoice
  if (eventObject.object === "invoice") {
    if (eventObject.lines && eventObject.lines.data.length > 0) {
      items = eventObject.lines.data;
    } else {
      logError("updateBillingRecord: No items found in invoice", {
        eventObject,
      });
    }
  }

  // 2️⃣ Check if the event object is a subscription
  if (eventObject.object === "subscription") {
    if (eventObject.items && eventObject.items.data.length > 0) {
      items = eventObject.items.data;
    } else {
      logError("updateBillingRecord: No items found in subscription", {
        eventObject,
      });
    }
  }

  // 3️⃣ If no items were found, log error and exit
  if (items.length === 0) {
    logError("updateBillingRecord: No valid items found for billing update", {
      eventObject,
    });
    return;
  }

  // 4️⃣ Extract plan, on plan switches the first line is the credit for the old plan
  const line =
    items.find((item: { amount?: number }) => (item.amount ?? 0) > 0) ??
      items[0];
  const priceId = line.price?.lookup_key;
  const plan = PLAN_MAPPING[priceId];
  if (!plan) {
    await monitor.warn(
      `Unrecognised Stripe price ${priceId}, so no plan was changed`,
      {
        userId,
        customer: eventObject.customer,
      },
    );
    return;
  }

  // 5️⃣ Get next payment due date (if applicable)
  const periodEnd = eventObject.current_period_end || line.period?.end;
  const nextPaymentDue = periodEnd
    ? new Date(periodEnd * 1000).toISOString()
    : null;

  // 6️⃣ Build metadata for storage
  const billingMeta = {
    total: eventObject.amount_paid || eventObject.amount_due || 0,
    currency: eventObject.currency,
    invoice_number: eventObject.number || null,
    paid: eventObject.paid === true,
    subscription_id: eventObject.subscription || eventObject.id,
    billing_reason: eventObject.billing_reason || "unknown",
    customer: eventObject.customer || null,
    invoice_pdf: eventObject.invoice_pdf || null,
    plan_id: priceId,
  };

  // 7️⃣ Insert or update billing record
  const { data, error } = await supabase
    .from("billing")
    .upsert(
      {
        user_id: userId,
        current_plan: plan,
        next_payment_due: nextPaymentDue,
        billing_method: "stripe",
        updated_at: new Date().toISOString(),
        meta: billingMeta,
      },
      { onConflict: "user_id" },
    );

  if (error) {
    throw new Error(`Failed to set ${userId} to ${plan}: ${error.message}`);
  }
  logInfo("Billing updated successfully", { userId, plan });
}

/**
 * Downgrades a user on a paid plan to free, leaving hand-set plans alone
 */
async function downgradeToFreePlan(userId: string) {
  const { data, error } = await supabase
    .from("billing")
    .update({
      current_plan: "free",
      next_payment_due: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .in("current_plan", PAID_PLANS)
    .select("user_id");

  if (error) {
    throw new Error(`Failed to downgrade ${userId}: ${error.message}`);
  }
  logInfo(
    data.length ? "User downgraded to free plan" : "User not on a paid plan",
    { userId },
  );
}

/**
 * Extracts user_id safely
 */
function getUserId(
  session: Stripe.Checkout.Session | null,
  subscription: Stripe.Subscription,
): string | null {
  return session?.subscription_details?.metadata?.user_id ||
    subscription?.metadata?.user_id ||
    subscription?.subscription_details?.metadata?.user_id ||
    null;
}

/**
 * Extracts user_id from invoice safely
 */
function getUserIdFromInvoice(invoice: Stripe.Invoice): string | null {
  return invoice.lines?.data?.[0]?.metadata?.user_id ||
    invoice.subscription_details?.metadata?.user_id || null;
}

/**
 * Sends an email (Placeholder function)
 */
function sendEmail(userId: string, eventName: string) {
  logInfo(`(Email) Notify user ${userId} about ${eventName}`);
}

/**
 * Centralized logging
 */
function logInfo(msg: string, extra?: any) {
  console.log(`INFO: ${msg}`, extra ?? "");
}
function logError(msg: string, extra?: any) {
  console.error(`ERROR: ${msg}`, extra ?? "");
}

/**
 * Response helpers
 */
function respSuccess() {
  return new Response(JSON.stringify({ received: true }), { status: 200 });
}
function respError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), { status });
}
