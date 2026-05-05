/**
 * Runs as a cron
 * Fetches all domains and users
 * Then calls the domain-updater function for eligible each domain
 * Logs responses, and returns a summary response
 */

import { serve } from "../shared/serveWithCors.ts";
import { getSupabaseClient } from "../shared/supabaseClient.ts";
import { Monitor } from "../shared/monitor.ts";

// Keys
const DB_URL = Deno.env.get("DB_URL") ?? Deno.env.get("SUPABASE_URL") ?? "";
const monitor = new Monitor("trigger-updates");

if (!DB_URL) {
  throw new Error("❌ Database URL and Key must be provided.");
}
const DOMAIN_UPDATER_URL = Deno.env.get("WORKER_DOMAIN_UPDATER_URL") ??
  `${DB_URL}/functions/v1/domain-updater`;

// Helper function to call the domain updater for a specific domain and user
async function updateDomainForUser(
  domain: string,
  userId: string,
  req: Request,
) {
  try {
    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "");
    const response = await fetch(DOMAIN_UPDATER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      },
      body: JSON.stringify({ domain, user_id: userId }),
      signal: AbortSignal.timeout(45_000),
    });

    const responseBody = await response.json();
    console.info(responseBody.message);

    if (responseBody.error) {
      console.error("❌", responseBody.error);
    } else if (!response.ok) {
      console.error("❌", response.statusText);
    }
  } catch (error) {
    console.error("❌", (error as Error).message);
  }
}

const BATCH_SIZE = Number(Deno.env.get("TRIGGER_UPDATES_BATCH_SIZE") ?? 10);

// Process a batch of domains concurrently, bounded by BATCH_SIZE.
async function processBatch(
  batch: { domain_name: string; user_id: string }[],
  req: Request,
) {
  await Promise.allSettled(
    batch.map((d) => updateDomainForUser(d.domain_name, d.user_id, req)),
  );
}

// Process every domain in batches; parallel within a batch, sequential between.
async function processAllDomains(req: Request) {
  const supabase = getSupabaseClient(req);
  const startTime = performance.now();
  const { data: domains, error } = await supabase
    .from("domains")
    .select("user_id, domain_name");

  if (error || !domains) {
    console.error("Error fetching domains:", error?.message);
    throw new Error("Error fetching domains");
  }

  for (let i = 0; i < domains.length; i += BATCH_SIZE) {
    await processBatch(domains.slice(i, i + BATCH_SIZE), req);
  }

  const duration = ((performance.now() - startTime) / 1000).toFixed(1);
  return `✅ ${domains.length} domains processed successfully in ${duration} seconds`;
}

// Supabase serverless function handler
serve(async (req) => {
  await monitor.start(req);
  try {
    const result = await processAllDomains(req);
    await monitor.success(result);
    return new Response(result, { status: 200 });
  } catch (error) {
    await monitor.fail(error);
    console.error("Unexpected error:", (error as Error).message);
    return new Response("Internal Server Error", { status: 500 });
  }
});
