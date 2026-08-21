// File: ./supabase/functions/website-monitor/index.ts

import { serve } from "../shared/serveWithCors.ts";
import { performance } from "https://deno.land/std@0.140.0/node/perf_hooks.ts";

import { getSupabaseClient } from "../shared/supabaseClient.ts";
import { Logger } from "../shared/logger.ts";
import { Monitor } from "../shared/monitor.ts";

const TIMEOUT = 5000; // Timeout in ms
const logger = new Logger("website-monitor");
const monitor = new Monitor("website-monitor");

interface Billing {
  user_id: string;
}

interface HealthCheckResult {
  id: string;
  isUp: boolean;
  responseCode: number | null;
  responseTimeMs: number | null;
  dnsTimeMs: number | null;
  sslTimeMs: number | null;
}

const responseHeaders = {
  headers: { "Content-Type": "application/json" },
};

// Perform DNS, HTTPS, and latency checks with timeout
async function checkDomainHealth(
  domain: string,
): Promise<Omit<HealthCheckResult, "id">> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT);
  let dnsTimeMs = null;
  let sslTimeMs = null;

  try {
    const start = performance.now();

    const dnsStart = performance.now();
    await Deno.resolveDns(domain, "A");
    dnsTimeMs = performance.now() - dnsStart;

    const response = await fetch(`https://${domain}`, {
      signal: controller.signal,
    });

    const sslStart = performance.now();
    if (response.url.startsWith("https://")) {
      await fetch(response.url, { signal: controller.signal });
    }
    sslTimeMs = performance.now() - sslStart;

    const responseTime = performance.now() - start;
    clearTimeout(timeout);

    return {
      isUp: response.ok,
      responseCode: response.status,
      responseTimeMs: responseTime,
      dnsTimeMs,
      sslTimeMs,
    };
  } catch (error: Error | any) {
    clearTimeout(timeout);
    if (error instanceof Error && error.name === "AbortError") {
      logger.warn(`Timeout reached while checking domain: ${domain}`);
    } else {
      logger.error(
        `Unexpected error checking domain ${domain}: ${error?.message}`,
      );
    }
    return {
      isUp: false,
      responseCode: null,
      responseTimeMs: null,
      dnsTimeMs,
      sslTimeMs,
    };
  }
}

// Main handler
serve(async (req: Request) => {
  logger.info("🔁 Website monitor function started");
  await monitor.start(req);
  const supabase = getSupabaseClient(req);

  try {
    // Step 1: Find users on "pro" plan
    const { data: billingData, error: billingError } = await supabase
      .from("billing")
      .select("user_id")
      .eq("current_plan", "pro");

    if (billingError) {
      const message = `Error fetching billing users: ${billingError.message}`;
      logger.error(message);
      await monitor.fail(`Billing query failed: ${billingError.message}`);
      return new Response(
        JSON.stringify({ error: "Billing query failed" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const userIds = (billingData ?? []).map((row: Billing) => row.user_id);
    if (userIds.length === 0) {
      await monitor.fail("No pro users found");
      logger.info("No pro users found");
      return new Response(
        JSON.stringify({ message: "User(s) not on pro plan" }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      );
    }

    // Step 2: Fetch domains owned by pro users
    const { data: domains, error: domainError } = await supabase
      .from("domains")
      .select("id, domain_name, user_id")
      .in("user_id", userIds);

    if (domainError) {
      logger.error(`Error fetching domains: ${domainError.message}`);
      await monitor.fail(`Domain query failed: ${domainError.message}`);
      return new Response(
        JSON.stringify({ error: "Domain query failed" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    if (!domains || domains.length === 0) {
      logger.info("No domains found for pro users");
      await monitor.success("No domains to monitor");
      return new Response(
        JSON.stringify({ message: "No domains to monitor" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Step 3: Run checks and collect uptime metrics
    const results: HealthCheckResult[] = await Promise.all(
      domains.map(async ({ id, domain_name }) => {
        const health = await checkDomainHealth(domain_name);
        return { id, ...health };
      }),
    );

    // Step 4: Insert results into uptime table
    const { error: insertError } = await supabase
      .from("uptime")
      .insert(
        results.map((
          { id, isUp, responseCode, responseTimeMs, dnsTimeMs, sslTimeMs },
        ) => ({
          domain_id: id,
          is_up: isUp,
          response_code: responseCode,
          response_time_ms: responseTimeMs,
          dns_lookup_time_ms: dnsTimeMs,
          ssl_handshake_time_ms: sslTimeMs,
        })),
      );

    if (insertError) {
      logger.error(`Error inserting uptime data: ${insertError.message}`);
      await monitor.fail(`Insert uptime failed: ${insertError.message}`);
      return new Response(
        JSON.stringify({ error: "Failed to insert uptime" }),
        { status: 500 },
      );
    }

    const summary =
      `✅ Website monitor complete – ${results.length} domains checked`;
    logger.info(summary);
    await logger.flushToRemote();
    await monitor.success(summary);
    return new Response(JSON.stringify({ message: summary }), { status: 200 });
  } catch (err: any) {
    await monitor.fail(`Unhandled error: ${err.message}`);
    logger.error(`Unhandled error: ${err.message}`);
    await logger.flushToRemote();
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
    });
  }
});
