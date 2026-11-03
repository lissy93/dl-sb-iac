import { serve } from "../shared/serveWithCors.ts";
import { getSupabaseClient, getUserOrNull } from "../shared/supabaseClient.ts";
import { Monitor } from "../shared/monitor.ts";
import {
  listPayingSubscriptions,
  type StripeSubscription,
} from "../shared/stripe.ts";

const STRIPE_API = "https://api.stripe.com/v1";

const monitor = new Monitor("checkout-session");

/** Helper to get env var, or fallback, or throw error. */
function getEnvVar(name: string, fallback?: string): string {
  const val = Deno.env.get(name)?.trim() ?? fallback;
  if (!val) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return val;
}

/** Flatten an object into x-www-form-urlencoded style keys */
function flattenObject(obj: any): Record<string, string> {
  const result: Record<string, string> = {};

  function flatten(obj: any, prefix: string = ""): void {
    Object.entries(obj).forEach(([key, value]) => {
      const newKey = prefix ? `${prefix}[${key}]` : key;
      if (Array.isArray(value)) {
        value.forEach((item, index) => flatten(item, `${newKey}[${index}]`));
      } else if (value && typeof value === "object") {
        flatten(value, newKey);
      } else {
        result[newKey] = String(value);
      }
    });
  }
  flatten(obj);
  return result;
}

/** Calls the Stripe API, throwing with Stripe's own message on failure */
async function stripeRequest(
  secretKey: string,
  path: string,
  body?: Record<string, unknown>,
) {
  const res = await fetch(`${STRIPE_API}/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Bearer ${secretKey}`,
    },
    body: body && new URLSearchParams(flattenObject(body)).toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe Error: ${data?.error?.message ?? res.status}`);
  }
  return data;
}

/** Sends a subscriber to Stripe's portal to confirm a switch to the new price */
async function createPlanSwitchUrl(
  secretKey: string,
  subscription: StripeSubscription,
  priceId: string,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const item = subscription.items.data[0];
  const portal = await stripeRequest(secretKey, "billing_portal/sessions", {
    customer: subscription.customer,
    return_url: cancelUrl,
    flow_data: {
      type: "subscription_update_confirm",
      subscription_update_confirm: {
        subscription: subscription.id,
        items: [{ id: item.id, price: priceId, quantity: 1 }],
      },
      after_completion: {
        type: "redirect",
        redirect: { return_url: successUrl },
      },
    },
  });
  console.info(
    `🔀 Switching ${subscription.customer} from ${item.price.lookup_key} to ${priceId}`,
  );
  return portal.url;
}

/** productId -> env var name => actual Stripe price ID */
const productIdToEnvVar: Record<string, string> = {
  "dl_hobby_monthly": "STRIPE_PRICE_HM",
  "dl_hobby_annual": "STRIPE_PRICE_HA",
  "dl_pro_monthly": "STRIPE_PRICE_PM",
  "dl_pro_annual": "STRIPE_PRICE_PA",
};

const responseHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

serve(async (req: Request) => {
  const supabase = getSupabaseClient(req);

  // 1) Get environment vars (or fallback)
  try {
    const STRIPE_SECRET_KEY = getEnvVar("STRIPE_SECRET_KEY");
    const STRIPE_ENDPOINT = getEnvVar(
      "STRIPE_ENDPOINT",
      "https://api.stripe.com/v1/checkout/sessions",
    );
    const APP_BASE_URL = getEnvVar("DL_BASE_URL", "https://domain-locker.com");

    if (!STRIPE_SECRET_KEY) {
      return new Response(
        JSON.stringify({ error: "Stripe keys are not configured" }),
        { headers: responseHeaders, status: 500 },
      );
    }

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Only POST allowed" }), {
        headers: responseHeaders,
        status: 405,
      });
    }

    // 2) Parse JSON from body
    let body: any;
    try {
      body = await req.json();
    } catch (err) {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        headers: responseHeaders,
        status: 400,
      });
    }

    const { productId, callbackUrl } = body || {};
    if (!productId) {
      return new Response(
        JSON.stringify({ error: "Missing required field: productId" }),
        { headers: responseHeaders, status: 400 },
      );
    }

    const user = await getUserOrNull(req);
    if (!user) {
      return new Response(
        JSON.stringify({ error: "Please sign in again to upgrade" }),
        { headers: responseHeaders, status: 401 },
      );
    }
    const userId = user.id;

    // 3) Map productId -> env var -> actual Stripe price ID
    const envVarName = productIdToEnvVar[productId];
    if (!envVarName) {
      return new Response(
        JSON.stringify({ error: `Invalid productId: ${productId}` }),
        { headers: responseHeaders, status: 400 },
      );
    }
    const priceId = getEnvVar(envVarName);

    // 4) Build the payload to send to Stripe
    const cancelUrl = new URL(callbackUrl || APP_BASE_URL);
    cancelUrl.searchParams.set("canceled", "true");
    const finalCancelUrl = cancelUrl.toString();

    const successUrl = new URL(callbackUrl || APP_BASE_URL);
    successUrl.searchParams.set("refresh", "true");
    successUrl.searchParams.set("success", "true");
    const finalSuccessUrl = successUrl.toString();

    const line_items = [{ price: priceId, quantity: 1 }];

    const subscription_data = { metadata: { user_id: userId } };
    const { data: billing, error: billingError } = await supabase
      .from("billing")
      .select("meta")
      .eq("user_id", userId)
      .maybeSingle();
    if (billingError) {
      throw new Error(
        `Couldn't read billing for ${userId}: ${billingError.message}`,
      );
    }

    const customerId = billing?.meta?.customer ?? null;
    if (customerId) {
      console.info(`✅ Using existing Stripe customer: ${customerId}`);
    }

    // Existing subscribers switch plan, rather than starting a second subscription
    const subscriptions = customerId
      ? await listPayingSubscriptions({ customer: customerId })
      : [];
    const subscription = subscriptions.find((sub) => !sub.cancel_at_period_end);
    if (subscription?.items.data[0].price.id === priceId) {
      return new Response(
        JSON.stringify({ error: "You're already on this plan" }),
        { headers: responseHeaders, status: 400 },
      );
    }
    if (subscription) {
      const url = await createPlanSwitchUrl(
        STRIPE_SECRET_KEY,
        subscription,
        priceId,
        finalSuccessUrl,
        finalCancelUrl,
      );
      return new Response(JSON.stringify({ url }), {
        headers: responseHeaders,
        status: 200,
      });
    }

    const payload: any = {
      line_items,
      mode: "subscription",
      subscription_data,
      success_url: finalSuccessUrl,
      cancel_url: finalCancelUrl,
      allow_promotion_codes: true,
    };

    if (customerId) {
      payload.customer = customerId;
    }

    // Flatten + encode
    const formBody = new URLSearchParams(flattenObject(payload)).toString();

    // 5) Make request to Stripe
    const headers: HeadersInit = {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
    };

    const stripeRes = await fetch(STRIPE_ENDPOINT, {
      method: "POST",
      headers,
      body: formBody,
    });

    const data = await stripeRes.json();
    if (!stripeRes.ok || !data?.url) {
      const msg = data?.error?.message || data?.error ||
        "Failed to create checkout session";
      await monitor.fail(new Error(`Checkout failed: ${msg}`), {
        userId,
        productId,
      });
      return new Response(
        JSON.stringify({ error: `Stripe Error: ${msg}` }),
        { headers: responseHeaders, status: 400 },
      );
    }

    // On success, return { url: data.url }
    return new Response(JSON.stringify({ url: data.url }), {
      headers: responseHeaders,
      status: 200,
    });
  } catch (err: any) {
    // If any environment var missing or logic error
    console.error("checkout-session error:", err);
    await monitor.fail(err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { headers: responseHeaders, status: 400 },
    );
  }
});
