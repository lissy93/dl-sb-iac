import { serve } from "../shared/serveWithCors.ts";
import { getSupabaseClient } from "../shared/supabaseClient.ts";
import { Monitor } from "../shared/monitor.ts";

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

const STRIPE_PLAN_MAPPING: Record<string, string> = {
  "dl_hobby_monthly": "hobby",
  "dl_hobby_annual": "hobby",
  "dl_pro_monthly": "pro",
  "dl_pro_annual": "pro",
};

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
  if (!SPONSORS_API) return new Set();

  try {
    const res = await fetch(`${SPONSORS_API}/lissy93`);
    if (!res.ok) throw new Error("Failed to fetch GitHub sponsors");

    const sponsors = await res.json();
    return new Set(
      sponsors.map((s: { login: string }) => (s.login || "").toLowerCase()),
    );
  } catch (err) {
    console.error("❌ Error fetching GitHub sponsors:", err);
    return new Set();
  }
}

/**
 * Checks if a user has an active Stripe subscription.
 * Returns the corresponding billing plan or `null` if none.
 */
/**
 * Fetches the Stripe billing plan for a user.
 * Uses `customer_id` for efficient lookup.
 */
async function getActiveStripePlan(customerId: string): Promise<string | null> {
  try {
    const url =
      `https://api.stripe.com/v1/customers/${customerId}/subscriptions?limit=1&expand[]=data.items`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text();
      console.warn(
        `⚠️ Stripe returned error for subscriptions: ${res.status} ${body}`,
      );
      return null;
    }

    const data = await res.json();
    const subscription = data?.data?.[0];
    if (!subscription) {
      console.info(
        `ℹ️ No active subscriptions found for customer ${customerId}`,
      );
      return null;
    }

    const lookupKey = subscription.items?.data?.[0]?.price?.lookup_key;
    if (!lookupKey) {
      console.warn(
        `⚠️ No price.lookup_key on active subscription for ${customerId}`,
      );
      return null;
    }

    console.info(`✅ Found active Stripe plan: ${lookupKey} for ${customerId}`);
    return STRIPE_PLAN_MAPPING[lookupKey] || null;
  } catch (err) {
    console.error(
      `❌ Error fetching active subscription for ${customerId}:`,
      err,
    );
    return null;
  }
}

/**
 * Determines the correct billing plan for a user.
 * Prioritizes Stripe over GitHub sponsorships.
 */
async function determineBillingPlan(
  userId: string,
  stripeCustomerId: string | null,
  supabase: ReturnType<typeof getSupabaseClient>,
): Promise<string> {
  console.info("🔍 Determining appropriate billing plan for user");
  const user = await getUser(userId, supabase);
  if (!user) {
    console.error(
      `❌ Cannot determine billing plan. User ${userId} does not exist.`,
    );
    return "free";
  }

  // Check Stripe first (higher priority)
  if (stripeCustomerId) {
    const stripePlan = await getActiveStripePlan(stripeCustomerId);
    if (stripePlan) return stripePlan;
  }

  // Check GitHub sponsors
  const githubUsername = user.user_metadata?.user_name ??
    user.user_metadata?.github_username;
  if (!githubUsername || user.app_metadata?.provider !== "github") {
    return "free";
  }

  const sponsors = await fetchGitHubSponsors();
  return sponsors.has(githubUsername.toLowerCase()) ? "sponsor" : "free";
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
 * Ensures the user has a billing entry with the correct plan.
 */
async function setupUserBilling(
  userId: string,
  supabase: ReturnType<typeof getSupabaseClient>,
) {
  console.log(`🔍 Checking billing for user ${userId}`);

  try {
    // Step 1: Fetch billing record if it exists
    const { data: existing, error: fetchError } = await supabase
      .from("billing")
      .select("current_plan, meta, created_at")
      .eq("user_id", userId)
      .maybeSingle();

    const currentPlan = existing?.current_plan ?? "free";
    const existingMeta = existing?.meta ?? {};
    console.info(`ℹ️ User ${userId} current plan: ${currentPlan}`);

    // Step 3: Get Stripe customer ID (may create if missing)
    const stripeCustomerId = await createGetStripeCustomer(userId, supabase);

    // Step 2: Determine correct plan
    const newPlan = await determineBillingPlan(
      userId,
      stripeCustomerId,
      supabase,
    );
    if (!newPlan) {
      console.error(`❌ Could not determine billing plan for user ${userId}`);
      return;
    }

    // Step 4: Build updated meta object
    const updatedMeta = {
      ...existingMeta,
      ...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
    };

    // Step 5: Insert or update billing record
    const timestamp = new Date().toISOString();

    // Do not downgrade complimentary users
    if (currentPlan === "complimentary" && newPlan === "free") {
      console.info(
        `⚖️ User ${userId} has complimentary plan, skipping downgrade`,
      );
      return;
    }

    const { error: upsertError } = await supabase
      .from("billing")
      .upsert(
        {
          user_id: userId,
          current_plan: newPlan,
          meta: updatedMeta,
          updated_at: timestamp,
          created_at: existing?.created_at ?? timestamp,
        },
        { onConflict: "user_id" },
      );

    if (upsertError) throw upsertError;

    // Step 6: Notify user only if plan has changed and is not "free"
    const shouldNotify = newPlan !== "free" && newPlan !== currentPlan;
    if (shouldNotify) {
      console.info(`📬 Sending billing upgrade notification to ${userId}`);
      fetch(NOTIFICATION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          message: `You've been upgraded to the ${newPlan} plan! 🎉`,
        }),
      }).catch((err) => console.error("❌ Error sending notification:", err));
    }

    console.info(`✅ Billing setup complete for ${userId} — Plan: ${newPlan}`);
  } catch (err) {
    console.error(`❌ Billing setup failed for user ${userId}:`, err);
  }
}

/**
 * Supabase Edge Function: Handles user signup events and manual re-checks.
 */
serve(async (req) => {
  await monitor.start(req);
  const supabase = getSupabaseClient(req);

  try {
    const body = await req.json();
    const userId = body.user?.id || body.userId || body.user_id;

    // If userId is provided, run single-user mode
    if (userId) {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Operation timed out")), 5000)
      );
      await Promise.race([setupUserBilling(userId, supabase), timeout]);
      await monitor.success(`Billing check complete for user ${userId}`);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }

    // Otherwise, run for all users
    const { data: usersPage, error } = await supabase.auth.admin.listUsers();
    const users = usersPage?.users ?? [];

    if (error || !users || users.length === 0) {
      throw new Error("Failed to fetch user list or no users found");
    }

    let successCount = 0;
    let failureCount = 0;

    for (const user of users) {
      const id = user.id;
      try {
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Operation timed out")), 2000)
        );
        await Promise.race([setupUserBilling(id, supabase), timeout]);
        successCount++;
      } catch (err: any) {
        console.warn(
          `⚠️ Skipping user ${id} due to timeout or error:`,
          err.message || err,
        );
        failureCount++;
      }
    }

    const summary =
      `Billing setup complete for ${successCount} user(s), ${failureCount} failed.`;
    await monitor.success(summary);
    return new Response(
      JSON.stringify({
        success: true,
        processed: successCount,
        failed: failureCount,
      }),
      {
        status: 200,
      },
    );
  } catch (err: any) {
    console.error("❌ Unexpected error:", err.message || err);
    await monitor.fail(err);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
    });
  }
});
