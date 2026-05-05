/**
 * Triggered by domain-update-worker (or trigger-updates) with { domain, user_id }.
 * Resolves the latest info inline (or via AS93 legacy endpoint if explicitly enabled),
 * compares with the database, then writes diffs and notifications.
 */

import { serve } from "../shared/serveWithCors.ts";
import { getSupabaseClient } from "../shared/supabaseClient.ts";
import { Logger } from "../shared/logger.ts";
import { resolveDomainInfo } from "../shared/domainResolver.ts";

const AS93_DOMAIN_INFO_URL = Deno.env.get("AS93_DOMAIN_INFO_URL") ?? "";
const AS93_DOMAIN_INFO_KEY = Deno.env.get("AS93_DOMAIN_INFO_KEY") ?? "";
const USE_AS93_LEGACY = Deno.env.get("USE_AS93_LEGACY") === "true";
const LOG_IP_CHANGES = Deno.env.get("LOG_IP_CHANGES") === "true";

const logger = new Logger("[domain-updater]");

type Sb = ReturnType<typeof getSupabaseClient>;

// Per-request state. Avoids module-level mutables that would race under per_worker.
interface Ctx {
  sb: Sb;
  domainId: string;
  userId: string;
  changes: number;
}

// Legacy path: fetch from the original DigitalOcean function. Opt-in only.
async function fetchDomainDataRemote(domain: string) {
  const response = await fetch(AS93_DOMAIN_INFO_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${AS93_DOMAIN_INFO_KEY}`,
    },
    body: JSON.stringify({ domain }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`Upstream returned ${response.status} for ${domain}`);
  }
  const data = await response.json();
  return data?.body?.domainInfo ?? data?.domainInfo;
}

// Resolve domain info inline by default; opt-in to AS93 legacy via env var.
async function fetchDomainData(domain: string) {
  if (USE_AS93_LEGACY && AS93_DOMAIN_INFO_URL && AS93_DOMAIN_INFO_KEY) {
    return await fetchDomainDataRemote(domain);
  }
  const { domainInfo } = await resolveDomainInfo(domain);
  return domainInfo;
}

// Coerce any incoming date-ish value to a clean ISO string or null.
const sanitizeDate = (d: unknown): string | null => {
  if (d == null) return null;
  const s = typeof d === "string" ? d : (d instanceof Date ? d.toISOString() : String(d));
  if (!s.trim() || isNaN(new Date(s).getTime())) return null;
  return s;
};

// Compare dates ignoring time and timezone.
function areDatesEqual(date1: unknown, date2: unknown): boolean {
  const a = sanitizeDate(date1), b = sanitizeDate(date2);
  if (!a || !b) return false;
  return a.slice(0, 10) === b.slice(0, 10);
}

// Case-insensitive comparison for nullable string values.
function isDifferent(v1: string | null | undefined, v2: string | null | undefined) {
  return (v1?.toLowerCase() ?? "") !== (v2?.toLowerCase() ?? "");
}

const changeTypeToNotificationType: Record<string, string> = {
  registrar: "registrar",
  whois_organization: "whois_",
  dns_ns: "dns_",
  dns_txt: "dns_",
  dns_mx: "dns_",
  ip_ipv4: "ip_",
  ip_ipv6: "ip_",
  ssl_issuer: "ssl_issuer",
  host: "host",
  status: "status",
};

const fieldToHumanName: Record<string, string> = {
  registrar: "Registrar",
  whois_organization: "WHOIS Organization",
  dns_ns: "Nameserver",
  dns_txt: "TXT Record",
  dns_mx: "MX Record",
  ip_ipv4: "IPv4 Address",
  ip_ipv6: "IPv6 Address",
  ssl_issuer: "SSL Issuer",
  dates_expiry: "Expiry Date",
  dates_updated: "Last Update Date",
  status: "Domain Status",
};

// Insert a notification row when the user has the relevant preference enabled.
async function maybeNotify(
  ctx: Ctx, field: string, oldValue: any, newValue: any,
) {
  const notificationType = changeTypeToNotificationType[field];
  if (!notificationType) return;

  const { data: preference, error } = await ctx.sb
    .from("notification_preferences")
    .select("is_enabled")
    .eq("domain_id", ctx.domainId)
    .eq("notification_type", notificationType)
    .maybeSingle();
  if (error) {
    logger.error(`Notification preference lookup failed: ${error.message}`);
    return;
  }
  if (!preference?.is_enabled) return;

  const human = fieldToHumanName[field] ?? field;
  let message: string;
  if (oldValue == null || oldValue === "Unknown") {
    message = `${human} was added "${newValue}"`;
  } else if (newValue == null || newValue === "Unknown") {
    message = `${human} was removed "${oldValue}"`;
  } else {
    message = `The ${human} for your domain has changed from "${oldValue}" to "${newValue}".`;
  }

  const { error: insErr } = await ctx.sb.from("notifications").insert({
    user_id: ctx.userId,
    domain_id: ctx.domainId,
    change_type: field,
    message,
    sent: false,
    read: false,
  });
  if (insErr) logger.error(`Notification insert failed: ${insErr.message}`);
}

// Record a single domain change row plus optional notification.
async function recordChange(
  ctx: Ctx, changeType: string, field: string, oldValue: any, newValue: any,
) {
  if (newValue === "Unknown") return;
  if ((oldValue || "").toString().toLowerCase()
      === (newValue || "").toString().toLowerCase()) return;
  try {
    logger.debug(
      `Change ${field}: ${oldValue ?? "none"} → ${newValue ?? "none"} (${changeType})`,
    );
    ctx.changes++;
    await ctx.sb.from("domain_updates").insert({
      domain_id: ctx.domainId,
      user_id: ctx.userId,
      change: field,
      change_type: changeType,
      old_value: oldValue,
      new_value: newValue,
      date: new Date(),
    });
    await maybeNotify(ctx, field, oldValue, newValue);
  } catch (err) {
    logger.error(`Failed to record change for ${field}: ${(err as Error).message}`);
  }
}

// Resolve registrar by name, inserting a new row if needed; returns id or null.
async function resolveRegistrarId(ctx: Ctx, name: string, url: string | null) {
  const { data: existing } = await ctx.sb.from("registrars")
    .select("id").ilike("name", name).maybeSingle();
  if (existing) return existing.id as string;
  const { data: created, error } = await ctx.sb.from("registrars")
    .insert({ name, url }).select("id").single();
  if (error) {
    logger.error(`Failed to insert registrar ${name}: ${error.message}`);
    return null;
  }
  return created?.id as string ?? null;
}

// Update the registrar relation if the upstream name differs from current.
async function syncRegistrar(ctx: Ctx, info: any, current: any) {
  const newName = info.registrar?.name;
  const currentName = current.registrars?.name ?? null;
  if (!isDifferent(newName, currentName)) return;
  await recordChange(ctx, "updated", "registrar", currentName, newName ?? null);
  if (!newName) return;
  const registrarId = await resolveRegistrarId(ctx, newName, info.registrar?.url ?? null);
  if (registrarId) {
    await ctx.sb.from("domains").update({ registrar_id: registrarId })
      .eq("id", ctx.domainId);
  }
}

const WHOIS_FIELDS = [
  "name", "organization", "state", "city", "country", "postal_code",
] as const;

// Diff WHOIS contact fields and write a SINGLE upsert with every changed field.
async function syncWhois(ctx: Ctx, info: any, current: any) {
  const incoming = info.whois ?? {};
  const existing = current.whois_info ?? {};
  const updates: Record<string, string> = {};

  for (const field of WHOIS_FIELDS) {
    const newValue = incoming[field];
    if (!newValue) continue;
    if (isDifferent(newValue, existing[field])) {
      await recordChange(
        ctx, "updated", `whois_${field}`, existing[field] ?? null, newValue,
      );
      updates[field] = newValue;
    }
  }

  if (Object.keys(updates).length === 0) return;
  const { error } = await ctx.sb.from("whois_info").upsert(
    { domain_id: ctx.domainId, ...updates },
    { onConflict: "domain_id" },
  );
  if (error) logger.error(`whois_info upsert failed: ${error.message}`);
}

// Sync a single DNS record set (NS/MX/TXT). Skips writes when upstream is empty.
async function syncDnsRecordSet(ctx: Ctx, recordType: string, newRecords: string[]) {
  const { data: currentRecords } = await ctx.sb.from("dns_records")
    .select("*").eq("domain_id", ctx.domainId).eq("record_type", recordType);
  const current = currentRecords ?? [];
  if (!newRecords.length && current.length) return;

  const lower = newRecords.map((r) => r.toLowerCase());
  const added = lower.filter((r) =>
    !current.some((cr) => cr.record_value.toLowerCase() === r)
  );
  const removed = current.filter((cr) =>
    !lower.includes(cr.record_value.toLowerCase())
  );
  const tag = `dns_${recordType.toLowerCase()}`;

  for (const value of added) {
    await recordChange(ctx, "added", tag, null, value);
    await ctx.sb.from("dns_records").insert({
      domain_id: ctx.domainId, record_type: recordType, record_value: value,
    });
  }
  for (const r of removed) {
    await recordChange(ctx, "removed", tag, r.record_value, null);
    await ctx.sb.from("dns_records").delete().eq("id", r.id);
  }
}

async function syncDns(ctx: Ctx, info: any) {
  const map: Record<string, string> = {
    NS: "nameServers", TXT: "txtRecords", MX: "mxRecords",
  };
  for (const [recordType, key] of Object.entries(map)) {
    const newRecords = (info.dns?.[key] ?? []) as string[];
    await syncDnsRecordSet(ctx, recordType, newRecords);
  }
}

// Sync IPs to match upstream. Round-robin DNS makes the change log noisy, so
// add/remove events are suppressed unless LOG_IP_CHANGES=true.
async function syncIpVersion(
  ctx: Ctx, version: "ipv4" | "ipv6", newIps: string[],
) {
  const { data: currentIps } = await ctx.sb.from("ip_addresses")
    .select("*").eq("domain_id", ctx.domainId).eq("is_ipv6", version === "ipv6");
  const current = currentIps ?? [];
  if (!newIps.length && current.length) return;

  const lower = newIps.map((ip) => ip.toLowerCase());
  const added = lower.filter((ip) =>
    !current.some((cip) => cip.ip_address.toLowerCase() === ip)
  );
  const removed = current.filter((cip) =>
    !lower.includes(cip.ip_address.toLowerCase())
  );
  const tag = `ip_${version}`;

  for (const value of added) {
    if (LOG_IP_CHANGES) await recordChange(ctx, "added", tag, null, value);
    await ctx.sb.from("ip_addresses").insert({
      domain_id: ctx.domainId, ip_address: value, is_ipv6: version === "ipv6",
    });
  }
  for (const r of removed) {
    if (LOG_IP_CHANGES) await recordChange(ctx, "removed", tag, r.ip_address, null);
    await ctx.sb.from("ip_addresses").delete().eq("id", r.id);
  }
}

async function syncIps(ctx: Ctx, info: any) {
  for (const v of ["ipv4", "ipv6"] as const) {
    await syncIpVersion(ctx, v, info.ip_addresses?.[v] ?? []);
  }
}

// Sync SSL cert fields, never nulling existing values when upstream is empty.
async function syncSsl(ctx: Ctx, info: any, current: any) {
  const existing = current.ssl_certificates?.[0] ?? null;
  const issuer = info.ssl?.issuer ?? null;
  const validFrom = sanitizeDate(info.ssl?.valid_from);
  const validTo = sanitizeDate(info.ssl?.valid_to);
  const hasNew = !!(issuer || validFrom || validTo);
  if (!hasNew) return;

  if (!existing) {
    const { error } = await ctx.sb.from("ssl_certificates").insert({
      domain_id: ctx.domainId,
      issuer, valid_from: validFrom, valid_to: validTo,
    });
    if (error) logger.error(`ssl_certificates insert failed: ${error.message}`);
    return;
  }

  const changed = isDifferent(issuer, existing.issuer)
    || !areDatesEqual(validFrom, existing.valid_from)
    || !areDatesEqual(validTo, existing.valid_to);
  if (!changed) return;

  await recordChange(ctx, "updated", "ssl_issuer", existing.issuer, issuer);
  const { error } = await ctx.sb.from("ssl_certificates").update({
    issuer: issuer ?? existing.issuer,
    valid_from: validFrom ?? existing.valid_from,
    valid_to: validTo ?? existing.valid_to,
  }).eq("domain_id", ctx.domainId);
  if (error) logger.error(`ssl_certificates update failed: ${error.message}`);
}

// Sync ICANN status codes; treats empty upstream as transient and skips writes.
async function syncStatuses(ctx: Ctx, info: any) {
  const newStatuses = (info.status ?? []).map((s: string) => s.toLowerCase());
  const { data: currentStatuses } = await ctx.sb.from("domain_statuses")
    .select("*").eq("domain_id", ctx.domainId);
  const current = currentStatuses ?? [];
  if (!newStatuses.length && current.length) return;

  const added = newStatuses.filter((s: string) =>
    !current.some((cs: any) => cs.status_code.toLowerCase() === s)
  );
  const removed = current.filter((cs: any) =>
    !newStatuses.includes(cs.status_code.toLowerCase())
  );

  for (const value of added) {
    await recordChange(ctx, "added", "status", null, value);
    await ctx.sb.from("domain_statuses").insert({
      domain_id: ctx.domainId, status_code: value,
    });
  }
  for (const r of removed) {
    await recordChange(ctx, "removed", "status", r.status_code, null);
    await ctx.sb.from("domain_statuses").delete().eq("id", r.id);
  }
}

// Sync expiry/updated dates. Never overwrite existing date with empty upstream.
async function syncDates(ctx: Ctx, info: any, current: any) {
  const newExpiry = sanitizeDate(info.dates?.expiry_date);
  if (newExpiry && !areDatesEqual(newExpiry, current.expiry_date)) {
    await recordChange(
      ctx, "updated", "dates_expiry", current.expiry_date, newExpiry,
    );
    await ctx.sb.from("domains").update({ expiry_date: newExpiry })
      .eq("id", ctx.domainId);
  }
  const newUpdated = sanitizeDate(info.dates?.updated_date);
  if (newUpdated && !areDatesEqual(newUpdated, current.updated_date)) {
    await recordChange(
      ctx, "updated", "dates_updated", current.updated_date, newUpdated,
    );
    await ctx.sb.from("domains").update({ updated_date: newUpdated })
      .eq("id", ctx.domainId);
  }
}

// Run every sync step under a shared per-request context.
async function syncDomain(ctx: Ctx, info: any, current: any) {
  try {
    await syncRegistrar(ctx, info, current);
    await syncWhois(ctx, info, current);
    await syncDns(ctx, info);
    await syncIps(ctx, info);
    await syncSsl(ctx, info, current);
    await syncStatuses(ctx, info);
    await syncDates(ctx, info, current);
  } catch (err) {
    logger.error(
      `Failed to sync ${current.domain_name}: ${(err as Error).message}`,
    );
  }
}

const jsonResp = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResp({ message: "❌ Invalid request method" }, 405);
  }
  const sb = getSupabaseClient(req);

  let domain = "", user_id = "";
  try {
    const body = await req.json();
    domain = body.domain;
    user_id = body.user_id;
  } catch (err) {
    logger.error(`Failed to parse request body: ${(err as Error).message}`);
    return jsonResp({ message: "❌ Invalid request body" }, 400);
  }
  if (!domain || !user_id) {
    return jsonResp({
      message: "❌ Domain could not be updated",
      error: "Missing params, domain and/or user_id",
    }, 400);
  }

  try {
    logger.info(`Processing update for ${domain}`);
    const newDomainInfo = await fetchDomainData(domain);
    const { data: currentDomainRecord, error } = await sb
      .from("domains")
      .select(`
        *,
        registrars (name, url),
        ip_addresses (ip_address, is_ipv6),
        ssl_certificates (issuer, valid_from, valid_to),
        whois_info (name, organization, state, country, street, city, postal_code),
        dns_records (record_type, record_value),
        domain_statuses (status_code)
      `)
      .eq("domain_name", domain)
      .eq("user_id", user_id)
      .maybeSingle();

    if (error) {
      logger.error(`Failed to fetch domain record for ${domain}: ${error.message}`);
      return jsonResp({
        message: "❌ Error fetching domain record", error: error.message,
      }, 500);
    }
    if (!currentDomainRecord) {
      logger.warn(`Domain ${domain} not found for user ${user_id}`);
      return jsonResp({ message: "❌ Domain not found for user" }, 404);
    }

    // Bail out cleanly when upstream returned nothing useful, so we never
    // overwrite good data with a transient empty resolution.
    const hasAnySignal = !!(
      newDomainInfo?.dates?.expiry_date ||
      newDomainInfo?.dates?.creation_date ||
      newDomainInfo?.registrar?.name ||
      newDomainInfo?.ip_addresses?.ipv4?.length ||
      newDomainInfo?.dns?.nameServers?.length
    );
    if (!hasAnySignal) {
      logger.warn(`No usable data resolved for ${domain}, skipping update`);
      return jsonResp({ message: `⚠️ ${domain} resolved no data, skipped` }, 200);
    }

    const ctx: Ctx = {
      sb, domainId: currentDomainRecord.id, userId: user_id, changes: 0,
    };
    await syncDomain(ctx, newDomainInfo, currentDomainRecord);

    logger.success(`${domain} updated: ${ctx.changes} change(s)`);
    return jsonResp({
      message: `✅ ${domain} updated successfully: ${ctx.changes} changes.`,
    }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error(`Failed to update ${domain}: ${msg}`);
    return jsonResp({
      message: `⚠️ ${domain} could not be updated`, error: msg,
    }, 500);
  }
});
