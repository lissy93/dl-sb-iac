import { serve } from "../shared/serveWithCors.ts";
import { Logger } from "../shared/logger.ts";
import { resolveDomainInfo } from "../shared/domainResolver.ts";

const log = new Logger("[domain-info]");
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

// Build a JSON Response with consistent headers.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  const { searchParams } = new URL(req.url);
  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  const domain = searchParams.get("domain");

  if (!domain) {
    return jsonResponse({ error: "Domain name is required" }, 400);
  }
  if (!DOMAIN_RE.test(domain)) {
    log.warn(`Rejecting invalid domain: ${domain}`);
    return jsonResponse({ error: "Invalid domain format" }, 400);
  }

  try {
    log.info(`Resolving ${domain}`);
    const { domainInfo, errors } = await resolveDomainInfo(domain);
    const hasNetworkSignal = domainInfo.ip_addresses.ipv4.length > 0
      || domainInfo.ip_addresses.ipv6.length > 0
      || domainInfo.dns.nameServers.length > 0;
    const hasWhoisSignal = !!(domainInfo.dates.expiry_date
      || domainInfo.dates.creation_date
      || domainInfo.registrar.name);
    if (!hasNetworkSignal && !hasWhoisSignal) {
      log.warn(`No data resolved for ${domain}`);
      return jsonResponse({ error: "Failed to resolve domain", errors }, 502);
    }
    log.success(`Resolved ${domain}`);
    return jsonResponse({
      domainInfo,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    log.error(`Unexpected failure for ${domain}: ${(err as Error).message}`);
    return jsonResponse(
      { error: "An unexpected error occurred" },
      500,
    );
  }
}, ["GET", "OPTIONS"]);
