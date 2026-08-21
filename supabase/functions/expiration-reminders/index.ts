import { serve } from "../shared/serveWithCors.ts";
import { getSupabaseClient } from "../shared/supabaseClient.ts";
import { Monitor } from "../shared/monitor.ts";
import { one } from "../shared/embedded.ts";

const REMINDER_DAYS = [90, 30, 7, 2];

const monitor = new Monitor("expiration-reminders");

serve(async (req) => {
  await monitor.start(req);

  const supabase = getSupabaseClient(req);
  let reminderCount = 0;

  for (const days of REMINDER_DAYS) {
    const dateStr = getFutureDate(days);

    const { data: domains, error } = await supabase
      .from("domains")
      .select("id, domain_name, expiry_date, user_id, registrars(name)")
      .eq("expiry_date", dateStr);

    if (error) {
      console.error(`❌ Failed to query domains for ${days}d:`, error);
      continue;
    }

    for (const domain of domains ?? []) {
      const { id: domain_id, domain_name, user_id, registrars } = domain;
      const registrar = one(registrars)?.name;

      const message = `Domain ${domain_name} expiring in ${days} days.` +
        (registrar ? ` Renew it on ${registrar}.` : "");

      await supabase.from("notifications").insert({
        user_id,
        domain_id,
        change_type: "reminder",
        message,
        sent: false,
        read: false,
      });

      reminderCount++;
      console.log(`🔔 Reminder created for ${domain_name} (${days}d)`);
    }
  }

  const doneMessage = `Done. ${reminderCount} reminders created.`;
  await monitor.success(doneMessage);
  return new Response(doneMessage, { status: 200 });
});

function getFutureDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}
