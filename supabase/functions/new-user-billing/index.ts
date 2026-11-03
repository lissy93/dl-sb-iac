import { serve } from "../shared/serveWithCors.ts";
import { getSupabaseClient } from "../shared/supabaseClient.ts";
import type { User } from "https://esm.sh/@supabase/supabase-js@2";
import { Monitor } from "../shared/monitor.ts";
import {
  listPayingSubscriptions,
  PAID_PLANS,
  PLAN_MAPPING,
  type StripeSubscription,
} from "../shared/stripe.ts";

// Load environment variables
const DB_URL = Deno.env.get("DB_URL") ?? "";
const SPONSORS_API = Deno.env.get("AS93_SPONSORS_API") ?? "";
const NOTIFICATION_URL = Deno.env.get("WORKER_SEND_NOTIFICATION_URL") ??
  `${DB_URL}/functions/v1/send-notification`;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

// Ensure required environment variables are set
if (!STRIPE_SECRET_KEY) {
  console.warn(
    "⚠️ Missing STRIPE_SECRET_KEY. Stripe billing checks will be skipped.",
  );
}

// Plans this job decides, any other plan was set by hand and is left alone
const MANAGED_PLANS = ["free", "hobby", "pro", "sponsor"];

type Supabase = ReturnType<typeof getSupabaseClient>;
type Outcome = "created" | "changed" | "unchanged" | "manual" | "kept";
interface BillingRow {
  current_plan: string;
  meta: ({ customer?: string } & Record<string, unknown>) | null;
}

const monitor = new Monitor("user-billing-check");

/**
 * Fetches a user from Supabase Auth.
 * Fails fast if the user is not found.
 */
async function getUser(
  userId: string,
  supabase: ReturnType<typeof getSupabaseClient>,
): Promise<any | null> {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data?.user) {
      console.error(`❌ User ${userId} not found.`);
      return null;
    }
    return data.user;
  } catch (err) {
    console.error(`❌ Error fetching user ${userId}:`, err);
    return null;
  }
}

/**
 * Fetches the list of GitHub sponsors.
 */
async function fetchGitHubSponsors(): Promise<Set<string>> {
  if (!SPONSORS_API) throw new Error("AS93_SPONSORS_API is not set");

  const res = await fetch(`${SPONSORS_API}/lissy93`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub sponsors API returned ${res.status}`);

  const sponsors = await res.json();
  if (!sponsors.length) throw new Error("GitHub sponsors API returned none");
  return new Set(
    sponsors.map((s: { login: string }) => (s.login || "").toLowerCase()),
  );
}

/** Lowercase GitHub username, for users who signed in with GitHub */
function githubUsername(user: User): string {
  if (user.app_metadata?.provider !== "github") return "";
  const name = user.user_metadata?.user_name ??
    user.user_metadata?.github_username ?? "";
  return name.toLowerCase();
}

/** Picks a plan from Stripe, then GitHub sponsorship, throwing on unknown prices */
function pickPlan(
  subscription: StripeSubscription | undefined,
  isSponsor: boolean,
): string {
  if (!subscription) return isSponsor ? "sponsor" : "free";
  const lookupKey = subscription.items.data[0]?.price?.lookup_key;
  const plan = PLAN_MAPPING[lookupKey ?? ""];
  if (!plan) {
    throw new Error(
      `Unrecognised Stripe price ${lookupKey} on ${subscription.id}`,
    );
  }
  return plan;
}

/** Works out one user's plan from live Stripe and sponsor lookups */
async function determineBillingPlan(
  userId: string,
  stripeCustomerId: string | null,
  supabase: Supabase,
): Promise<string> {
  const user = await getUser(userId, supabase);
  if (!user) throw new Error(`Couldn't fetch user ${userId}`);

  const [subscription] = stripeCustomerId
    ? await listPayingSubscriptions({ customer: stripeCustomerId })
    : [];
  const username = githubUsername(user);
  const sponsors = !subscription && username
    ? await fetchGitHubSponsors()
    : new Set<string>();
  return pickPlan(subscription, sponsors.has(username));
}

/**
 * Creates a new Stripe customer, if one doesn't yet exist
 * @param userId
 * @returns
 */
async function createGetStripeCustomer(
  userId: string,
  supabase: ReturnType<typeof getSupabaseClient>,
): Promise<string | null> {
  if (!STRIPE_SECRET_KEY) {
    console.warn("⚠️ Stripe not configured.");
    return null;
  }

  try {
    console.info(`🔍 Looking up Stripe customer for user ${userId}`);

    // 1. Get user info (email required)
    const { data: userRes, error: userErr } = await supabase.auth.admin
      .getUserById(userId);
    const user = userRes?.user;
    const email = user?.email;
    if (userErr || !user || !email) {
      console.warn(`⚠️ Missing user or email for ${userId}`);
      return null;
    }

    // 2. Check billing.meta.customer
    const { data: billing, error: billingErr } = await supabase
      .from("billing")
      .select("meta")
      .eq("user_id", userId)
      .maybeSingle();

    const existingId = billing?.meta?.customer;
    if (existingId) {
      console.info(`✅ Found Stripe customer in billing.meta: ${existingId}`);
      return existingId;
    }

    // 3. Search Stripe for existing customer (metadata or email)
    const metaQuery = encodeURIComponent(`metadata['user_id']:'${userId}'`);
    const metaRes = await fetch(
      `https://api.stripe.com/v1/customers/search?query=${metaQuery}`,
      {
        headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
      },
    );
    const metaData = await metaRes.json();
    if (metaRes.ok && metaData?.data?.length > 0) {
      const foundId = metaData.data[0].id;
      console.info(`✅ Found Stripe customer via metadata: ${foundId}`);
      return foundId;
    }

    const emailRes = await fetch(
      `https://api.stripe.com/v1/customers?email=${
        encodeURIComponent(email)
      }&limit=1`,
      {
        headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
      },
    );
    const emailData = await emailRes.json();
    if (emailRes.ok && emailData?.data?.length > 0) {
      const foundId = emailData.data[0].id;
      console.info(`✅ Found Stripe customer via email: ${foundId}`);
      return foundId;
    }

    // 4. Create new customer
    const createRes = await fetch("https://api.stripe.com/v1/customers", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        email,
        name: user.user_metadata?.full_name ?? "",
        "metadata[user_id]": userId,
      }),
    });

    const customer = await createRes.json();
    if (!createRes.ok || !customer?.id) {
      console.error("❌ Failed to create Stripe customer:", customer);
      return null;
    }

    console.info(`🆕 Created new Stripe customer: ${customer.id}`);
    return customer.id;
  } catch (err) {
    console.error(`❌ Stripe customer setup failed for ${userId}:`, err);
    return null;
  }
}

/**
 * Saves a user's plan, skipping hand-set plans and rows changed since they were read
 * Paid plans are never lowered here, that's left to Stripe's cancellation webhook
 */
async function savePlan(
  supabase: Supabase,
  userId: string,
  existing: BillingRow | null | undefined,
  plan: string,
  customerId: string | null,
): Promise<Outcome> {
  const previous = existing?.current_plan;
  if (previous && !MANAGED_PLANS.includes(previous)) return "manual";
  if (
    PAID_PLANS.includes(previous ?? "") && plan !== previous && plan !== "pro"
  ) {
    return "kept";
  }

  const meta = {
    ...existing?.meta,
    ...(customerId && { customer: customerId }),
  };
  if (previous === plan && existing?.meta?.customer === meta.customer) {
    return "unchanged";
  }

  const now = new Date().toISOString();
  const { data, error } = existing
    ? await supabase.from("billing")
      .update({ current_plan: plan, meta, updated_at: now })
      .eq("user_id", userId)
      .eq("current_plan", previous)
      .select("user_id")
    : await supabase.from("billing").upsert(
      {
        user_id: userId,
        current_plan: plan,
        meta,
        created_at: now,
        updated_at: now,
      },
      { onConflict: "user_id", ignoreDuplicates: true },
    ).select("user_id");
  if (error) throw error;
  if (!data.length) return "unchanged";

  console.info(`✅ Plan for ${userId}: ${previous ?? "none"} → ${plan}`);
  if (plan !== "free" && plan !== previous) {
    fetch(NOTIFICATION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        message: `You've been upgraded to the ${plan} plan! 🎉`,
      }),
    }).catch((err) => console.error("❌ Error sending notification:", err));
  }
  return existing ? "changed" : "created";
}

/** Sets up or re-checks one user's billing, creating their Stripe customer if needed */
async function setupUserBilling(userId: string, supabase: Supabase) {
  const { data: existing, error } = await supabase
    .from("billing")
    .select("current_plan, meta")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;

  const customerId = existing?.meta?.customer ??
    await createGetStripeCustomer(userId, supabase);

  // Never overwrite an existing plan with a guess, but new users still start on free
  const plan = await determineBillingPlan(userId, customerId, supabase)
    .catch((err) => {
      if (existing) throw err;
      console.warn(`⚠️ Plan check failed for new user ${userId}:`, err);
      return "free";
    });
  const outcome = await savePlan(supabase, userId, existing, plan, customerId);
  console.info(`ℹ️ Billing check for ${userId}: ${outcome}, plan ${plan}`);
}

/** Every auth user, page by page until an empty page */
async function listAllUsers(supabase: Supabase): Promise<User[]> {
  const users: User[] = [];
  for (let page = 1;; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw error;
    if (!data.users.length) return users;
    users.push(...data.users);
  }
}

/** Every billing row by user, offset by rows read so any server row cap is respected */
async function listBillingRows(
  supabase: Supabase,
): Promise<Map<string, BillingRow>> {
  const rows = new Map<string, BillingRow>();
  for (;;) {
    const { data, error } = await supabase
      .from("billing")
      .select("user_id, current_plan, meta")
      .order("user_id")
      .range(rows.size, rows.size + 999);
    if (error) throw error;
    if (!data.length) return rows;
    data.forEach((row) => rows.set(row.user_id, row));
  }
}

/** Re-checks every user from bulk Stripe and sponsor data, aborting if a source fails */
async function syncAllUsers(supabase: Supabase) {
  const [users, rows] = await Promise.all([
    listAllUsers(supabase),
    listBillingRows(supabase),
  ]);
  if (!users.length) throw new Error("No users found");

  // Stripe is read after the billing rows, so it's never the older of the two
  const [subscriptions, sponsors] = await Promise.all([
    listPayingSubscriptions(),
    fetchGitHubSponsors(),
  ]);

  // Pro comes first then newest, and the first one seen for a user wins
  const isPro = (sub: StripeSubscription) =>
    PLAN_MAPPING[sub.items.data[0]?.price?.lookup_key ?? ""] === "pro";
  subscriptions.sort((a, b) => Number(isPro(b)) - Number(isPro(a)));
  const byUser = new Map<string, StripeSubscription>();
  const byCustomer = new Map<string, StripeSubscription>();
  for (const sub of subscriptions) {
    const subUserId = sub.metadata?.user_id;
    if (subUserId && !byUser.has(subUserId)) byUser.set(subUserId, sub);
    if (!byCustomer.has(sub.customer)) byCustomer.set(sub.customer, sub);
  }

  const counts: Record<Outcome, number> = {
    created: 0,
    changed: 0,
    unchanged: 0,
    manual: 0,
    kept: 0,
  };
  const failures: Record<string, unknown>[] = [];
  for (const user of users) {
    const row = rows.get(user.id);
    const subscription = byUser.get(user.id) ??
      byCustomer.get(row?.meta?.customer ?? "");
    const context = {
      userId: user.id,
      customer: row?.meta?.customer,
      subscription: subscription?.id,
    };
    try {
      const plan = pickPlan(subscription, sponsors.has(githubUsername(user)));
      const outcome = await savePlan(supabase, user.id, row, plan, null);
      counts[outcome]++;
      const previous = row?.current_plan;
      if (outcome === "changed") {
        await monitor.warn(
          `Daily check moved a user from ${previous} to ${plan}`,
          context,
        );
      }
      if (outcome === "kept") {
        await monitor.warn(
          `Daily check kept a user on ${previous} though it found ${plan}`,
          context,
        );
      }
    } catch (err) {
      failures.push({ ...context, error: (err as Error).message });
    }
  }
  const summary = {
    users: users.length,
    subscriptions: subscriptions.length,
    ...counts,
    failed: failures.length,
  };
  return { summary, failures };
}

/** Billing setup on signup (single user), or the daily re-check of everyone */
serve(async (req) => {
  await monitor.start(req);
  const supabase = getSupabaseClient(req);
  let userId: string | undefined;

  try {
    const body = await req.json();
    userId = body.user?.id || body.userId || body.user_id;

    if (userId) {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Operation timed out")), 5000)
      );
      await Promise.race([setupUserBilling(userId, supabase), timeout]);
      await monitor.success(`Billing check complete for user ${userId}`);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }

    const { summary, failures } = await syncAllUsers(supabase);
    if (failures.length) {
      await monitor.fail(
        new Error(`Billing check failed for ${failures.length} users`),
        { summary, failures: failures.slice(0, 20) },
      );
    } else {
      await monitor.success(
        `Billing check complete: ${JSON.stringify(summary)}`,
      );
    }
    return new Response(JSON.stringify({ success: true, ...summary }), {
      status: 200,
    });
  } catch (err: any) {
    console.error("❌ Billing check failed:", err.message || err);
    await monitor.fail(err, { userId });
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
    });
  }
});
