import { serve } from "../shared/serveWithCors.ts";
import { getSupabaseClient } from "../shared/supabaseClient.ts";
import { Logger } from "../shared/logger.ts";
import { Monitor } from "../shared/monitor.ts";

const logger = new Logger("cleanup-monitor-data");
const monitor = new Monitor("cleanup-monitor-data");

const RETENTION_DAYS = 7;

serve(async (req) => {
  await monitor.start(req);
  const supabase = getSupabaseClient(req);

  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
      .toISOString();

    logger.info(`⏳ Aggregating uptime data older than ${cutoff}`);

    // Collapse each old multi-record day into one averaged row (set-based)
    const { data: removed, error } = await supabase.rpc("aggregate_old_uptime", {
      cutoff_time: cutoff,
    });

    if (error) {
      logger.error(`❌ Aggregation failed: ${error.message}`);
      await logger.flushToRemote();
      await monitor.fail(error);
      return new Response("Internal Server Error", { status: 500 });
    }

    const msg = `✅ Aggregated old uptime data, removed ${removed ?? 0} detailed records`;
    logger.info(msg);
    await logger.flushToRemote();
    await monitor.success(msg);
    return new Response(msg, { status: 200 });
  } catch (err: any) {
    logger.error(`❌ Unexpected error: ${err.message}`);
    await logger.flushToRemote();
    await monitor.fail(err);
    return new Response("Internal Server Error", { status: 500 });
  }
});
