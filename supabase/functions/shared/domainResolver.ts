import { Logger } from "./logger.ts";
import { getWhoisInfo, type WhoisResult } from "./whois.ts";

const log = new Logger("[domainResolver]");

const DNS_TIMEOUT_MS = 5000;
const HTTP_TIMEOUT_MS = 5000;
const DOH_URL = "https://cloudflare-dns.com/dns-query";
const SSL_LABS_URL = "https://api.ssllabs.com/api/v3/analyze";
const IP_API_URL = "http://ip-api.com/json";

const DNS_TYPES: Record<string, number> = { A: 1, AAAA: 28, NS: 2, MX: 15, TXT: 16 };

export interface DomainInfo {
  domainName: string;
  status: string[];
  ip_addresses: { ipv4: string[]; ipv6: string[] };
  dates: {
    expiry_date: string | null;
    updated_date: string | null;
    creation_date: string | null;
  };
  registrar: {
    name: string | null;
    id: string | null;
    url: string | null;
    registryDomainId: string | null;
  };
  whois: {
    name: string | null;
    organization: string | null;
    street: string | null;
    city: string | null;
    country: string | null;
    state: string | null;
    postal_code: string | null;
  };
  abuse: { email: string | null; phone: string | null };
  dns: {
    dnssec: string | null;
    nameServers: string[];
    mxRecords: string[];
    txtRecords: string[];
  };
  ssl: {
    issuer: string | null;
    valid_from: string | null;
    valid_to: string | null;
    subject: string | null;
    fingerprint: string | null;
    key_size: number;
    signature_algorithm: string | null;
  };
  host: Record<string, unknown> | null;
}

export interface ResolveResult {
  domainInfo: DomainInfo;
  errors: string[];
}

// Run a function and capture any thrown error into the shared list.
async function safeRun<T>(
  fn: () => Promise<T>, label: string, errors: string[],
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    errors.push(label);
    log.warn(`${label}: ${(err as Error).message}`);
    return undefined;
  }
}

// Query Cloudflare DoH for one record type and map to plain string values.
async function dohQuery(domain: string, type: string): Promise<string[]> {
  const url = `${DOH_URL}?name=${encodeURIComponent(domain)}&type=${type}`;
  const res = await fetch(url, {
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const wantType = DNS_TYPES[type];
  const answers = (data.Answer ?? []).filter((r: any) => r.type === wantType);

  if (type === "MX") {
    return answers.map((r: any) => {
      const parts = String(r.data).split(" ");
      if (parts.length < 2) return r.data;
      const exchange = parts.slice(1).join(" ").replace(/\.$/, "");
      return `${exchange} (priority: ${parts[0]})`;
    });
  }
  if (type === "TXT") {
    return answers.map((r: any) => String(r.data).replace(/^"|"$/g, "").replace(/""/g, ""));
  }
  if (type === "NS") {
    return answers.map((r: any) => String(r.data).replace(/\.$/, ""));
  }
  return answers.map((r: any) => String(r.data));
}

// Convert SSL Labs millisecond timestamps to ISO date strings.
function tsToIsoDate(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    return value.trim() ? value : null;
  }
  if (typeof value === "number" && isFinite(value)) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

// Pull a single attribute (e.g. CN, O) from an X.509 distinguished name.
function dnAttr(dn: unknown, attr: string): string | null {
  if (typeof dn !== "string") return null;
  const m = dn.match(new RegExp(`(?:^|,)\\s*${attr}=([^,]+)`, "i"));
  return m ? m[1].trim() : null;
}

// Pull cached SSL Labs data; returns {} if not yet ready or unreachable.
async function getSslData(domain: string): Promise<DomainInfo["ssl"]> {
  const empty: DomainInfo["ssl"] = {
    issuer: null, valid_from: null, valid_to: null, subject: null,
    fingerprint: null, key_size: 0, signature_algorithm: null,
  };
  try {
    const url = `${SSL_LABS_URL}?host=${encodeURIComponent(domain)}&fromCache=on&all=done`;
    const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return empty;
    const data = await res.json();
    const cert = data?.certs?.[0];
    if (!cert || data.status !== "READY") return empty;
    return {
      issuer: dnAttr(cert.issuerSubject, "O") ?? cert.issuerSubject ?? null,
      valid_from: tsToIsoDate(cert.notBefore),
      valid_to: tsToIsoDate(cert.notAfter),
      subject: dnAttr(cert.subject, "CN") ?? cert.subject ?? null,
      fingerprint: cert.sha1Hash ?? null,
      key_size: cert.keySize ?? 0,
      signature_algorithm: cert.sigAlg ?? null,
    };
  } catch {
    return empty;
  }
}

// Best-effort IP geolocation lookup; returns {} on failure or rate-limit.
async function getHostData(ip: string): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`${IP_API_URL}/${encodeURIComponent(ip)}?fields=12249`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return {};
    const data = await res.json();
    // ip-api returns regionName; keep both for legacy frontend compatibility.
    if (data?.regionName && !data.region) data.region = data.regionName;
    return data;
  } catch {
    return {};
  }
}

// Override Cloudflare registrar URL when the upstream omits it.
function patchCloudflareUrl(reg: WhoisResult["registrar"]): WhoisResult["registrar"] {
  if (reg.name === "Cloudflare, Inc." && !reg.url) {
    return { ...reg, url: "https://www.cloudflare.com" };
  }
  return reg;
}

// Build a redacted-aware WHOIS object compatible with the legacy response shape.
function whoisToContact(whois: WhoisResult["whois"]): DomainInfo["whois"] {
  const v = (x: string | null | undefined) => (x && x.trim() ? x : "DATA REDACTED");
  return {
    name: v(whois.name),
    organization: v(whois.organization),
    street: v(whois.street),
    city: v(whois.city),
    country: v(whois.country),
    state: v(whois.state),
    postal_code: v(whois.postal_code),
  };
}

// Look up DNS, SSL and host info in parallel; safe to call when WHOIS failed.
async function gatherNetworkData(domain: string, errors: string[]) {
  const [ipv4, ipv6, ns, mx, txt, ssl] = await Promise.all([
    safeRun(() => dohQuery(domain, "A"), "ipv4-lookup", errors),
    safeRun(() => dohQuery(domain, "AAAA"), "ipv6-lookup", errors),
    safeRun(() => dohQuery(domain, "NS"), "ns-lookup", errors),
    safeRun(() => dohQuery(domain, "MX"), "mx-lookup", errors),
    safeRun(() => dohQuery(domain, "TXT"), "txt-lookup", errors),
    safeRun(() => getSslData(domain), "ssl-lookup", errors),
  ]);
  const host = (ipv4?.[0])
    ? await safeRun(() => getHostData(ipv4[0]), "host-lookup", errors)
    : null;
  return {
    ipv4: ipv4 ?? [], ipv6: ipv6 ?? [], ns: ns ?? [],
    mx: mx ?? [], txt: txt ?? [], ssl: ssl ?? null, host: host ?? null,
  };
}

// Resolve full domain info: WHOIS plus parallel DNS/SSL/host lookups.
export async function resolveDomainInfo(domain: string): Promise<ResolveResult> {
  const errors: string[] = [];
  const trimmed = domain.replace(/^(?:https?:\/\/)?(?:www\.)?/i, "").trim().toLowerCase();

  const [whois, network] = await Promise.all([
    safeRun(() => getWhoisInfo(trimmed), "whois-lookup", errors),
    gatherNetworkData(trimmed, errors),
  ]);

  const w: WhoisResult = whois ?? {
    domainName: trimmed,
    status: [],
    dnssec: null,
    dates: { creation_date: null, updated_date: null, expiry_date: null },
    registrar: { name: null, id: null, url: null, registryDomainId: null },
    whois: {
      name: null, organization: null, street: null, city: null,
      state: null, country: null, postal_code: null,
    },
    abuse: { email: null, phone: null },
  };
  const reg = patchCloudflareUrl(w.registrar);

  const domainInfo: DomainInfo = {
    domainName: w.domainName ?? trimmed,
    status: w.status,
    ip_addresses: { ipv4: network.ipv4, ipv6: network.ipv6 },
    dates: {
      expiry_date: w.dates.expiry_date ?? null,
      updated_date: w.dates.updated_date ?? null,
      creation_date: w.dates.creation_date ?? null,
    },
    registrar: {
      name: reg.name ?? null,
      id: reg.id ?? null,
      url: reg.url ?? null,
      registryDomainId: reg.registryDomainId ?? null,
    },
    whois: whoisToContact(w.whois),
    abuse: {
      email: w.abuse.email ?? null,
      phone: w.abuse.phone ?? null,
    },
    dns: {
      dnssec: w.dnssec ?? null,
      nameServers: network.ns,
      mxRecords: network.mx,
      txtRecords: network.txt,
    },
    ssl: network.ssl ?? {
      issuer: null, valid_from: null, valid_to: null, subject: null,
      fingerprint: null, key_size: 0, signature_algorithm: null,
    },
    host: network.host,
  };
  return { domainInfo, errors };
}
