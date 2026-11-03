const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

/** Our plan for each Stripe price lookup key */
export const PLAN_MAPPING: Record<string, string> = {
  "dl_hobby_monthly": "hobby",
  "dl_hobby_annual": "hobby",
  "dl_pro_monthly": "pro",
  "dl_pro_annual": "pro",
};

/** Plans that come from a Stripe subscription */
export const PAID_PLANS = ["hobby", "pro"];

/** Subscription states that still grant access, past_due is Stripe's retry window */
const PAYING_STATUSES = ["active", "trialing", "past_due"];

export interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  cancel_at_period_end: boolean;
  current_period_end: number;
  metadata?: { user_id?: string };
  items: {
    data: { id: string; price: { id: string; lookup_key: string | null } }[];
  };
}

/** Every paying Stripe subscription matching the filters, Pro first then newest */
export async function listPayingSubscriptions(
  filters: Record<string, string> = {},
): Promise<StripeSubscription[]> {
  const subscriptions: StripeSubscription[] = [];
  let startingAfter = "";
  do {
    const query = new URLSearchParams({ limit: "100", ...filters });
    if (startingAfter) query.set("starting_after", startingAfter);
    const res = await fetch(
      `https://api.stripe.com/v1/subscriptions?${query}`,
      {
        headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Stripe returned ${res.status}: ${await res.text()}`);
    }
    const page = await res.json();
    subscriptions.push(...page.data);
    startingAfter = page.has_more ? page.data.at(-1).id : "";
  } while (startingAfter);
  const isPro = (sub: StripeSubscription) =>
    Number(PLAN_MAPPING[sub.items.data[0]?.price?.lookup_key ?? ""] === "pro");
  return subscriptions
    .filter((sub) => PAYING_STATUSES.includes(sub.status))
    .sort((a, b) => isPro(b) - isPro(a));
}
