import { Logger } from "./logger.ts";

const log = new Logger("[whois]");

const TIMEOUT_MS = 5000;
const MAX_WHOIS_BYTES = 256 * 1024;
const IANA_BOOTSTRAP_RDAP = "https://data.iana.org/rdap/dns.json";
const IANA_WHOIS = "whois.iana.org";
const WHO_DAT_DEFAULT_URL = "https://who-dat.as93.net";
const WHO_DAT_UA = "domain-locker/1.0 (who-dat client)";

const tldWhoisCache = new Map<string, string | null>();
let rdapBootstrap: Map<string, string> | null = null;

export interface WhoisDates {
  creation_date?: string | null;
  updated_date?: string | null;
  expiry_date?: string | null;
}

export interface WhoisRegistrar {
  name?: string | null;
  id?: string | null;
  url?: string | null;
  registryDomainId?: string | null;
}

export interface WhoisContact {
  name?: string | null;
  organization?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  postal_code?: string | null;
}

export interface WhoisAbuse {
  email?: string | null;
  phone?: string | null;
}

export interface WhoisResult {
  domainName: string | null;
  status: string[];
  dnssec: string | null;
  dates: WhoisDates;
  registrar: WhoisRegistrar;
  whois: WhoisContact;
  abuse: WhoisAbuse;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DOMAIN_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function normalizeDomain(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if ([...raw].some((ch) => {
    const code = ch.charCodeAt(0);
    return code <= 31 || code === 127;
  })) return null;

  let host = raw;
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`,
    );
    host = url.hostname;
  } catch {
    return null;
  }

  host = host.replace(/^www\./i, "").replace(/\.$/, "").toLowerCase();
  if (!DOMAIN_RE.test(host)) return null;
  // Reject bare IPs and other all-numeric TLDs, which are never registrable.
  const tld = host.slice(host.lastIndexOf(".") + 1);
  return /^\d+$/.test(tld) ? null : host;
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day;
}

function isoDate(year: string, month: string, day: string): string | null {
  const y = Number(year), m = Number(month), d = Number(day);
  if (!isValidDateParts(y, m, d)) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${
    String(d).padStart(2, "0")
  }`;
}

// Parse a WHOIS date in any common format to YYYY-MM-DD, or null if unparseable.
export function parseDate(input: unknown): string | null {
  if (!input || typeof input !== "string") return null;
  const s = input.trim().replace(/\s+\([^)]*\)\s*$/, "").replace(
    /\s+[A-Z]{2,5}$/,
    "",
  );
  if (!s) return null;

  // ISO first, allowing the dotted (.ru/.su) and slashed year-first variants.
  const iso = s.match(/^(\d{4})[-/.](\d{2})[-/.](\d{2})/);
  if (iso) return isoDate(iso[1], iso[2], iso[3]);

  const dmy = s.match(/^(\d{1,2})[\-\/.](\d{1,2})[\-\/.](\d{4})/);
  if (dmy) {
    const [, a, b, y] = dmy;
    const ai = +a, bi = +b;
    const day = ai > 12 ? ai : (bi > 12 ? bi : ai);
    const month = ai > 12 ? bi : (bi > 12 ? ai : bi);
    return isoDate(y, String(month), String(day));
  }

  const dmonY = s.match(/^(\d{1,2})[\-\s]([A-Za-z]{3,9})[\-\s](\d{4})/);
  if (dmonY) {
    const month = MONTHS[dmonY[2].slice(0, 3).toLowerCase()];
    if (month) {
      return isoDate(dmonY[3], String(month), dmonY[1]);
    }
  }

  // Last resort. Use local components (runtime is UTC) so a date-only string is
  // not shifted a day by the toISOString timezone conversion.
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return isoDate(
      String(parsed.getFullYear()),
      String(parsed.getMonth() + 1),
      String(parsed.getDate()),
    );
  }
  return null;
}

// Coerce any date-ish value (WHOIS string, Date, or DB timestamp) to a clean
// YYYY-MM-DD string or null. This is the single format written to the database.
export function toIsoDate(value: unknown): string | null {
  if (value == null) return null;
  return parseDate(value instanceof Date ? value.toISOString() : String(value));
}

// True when a WHOIS date moved by more than `days` (default 2). Timezone rounding
// and registry-vs-registrar reporting differ by a day or two, while real expiry
// and registration changes are about a year, so smaller moves are treated as
// noise. A null new value is never a change; a first non-null value always is.
export function dateChangedBeyond(
  oldV: unknown,
  newV: unknown,
  days = 2,
): boolean {
  const b = toIsoDate(newV);
  if (!b) return false;
  const a = toIsoDate(oldV);
  if (!a) return true;
  const diff = Math.abs(new Date(b).getTime() - new Date(a).getTime());
  return diff > days * 86_400_000;
}

const KNOWN_STATUSES = [
  "clientDeleteProhibited",
  "clientHold",
  "clientRenewProhibited",
  "clientTransferProhibited",
  "clientUpdateProhibited",
  "serverDeleteProhibited",
  "serverHold",
  "serverRenewProhibited",
  "serverTransferProhibited",
  "serverUpdateProhibited",
  "inactive",
  "ok",
  "pendingCreate",
  "pendingDelete",
  "pendingRenew",
  "pendingRestore",
  "pendingTransfer",
  "pendingUpdate",
  "addPeriod",
  "autoRenewPeriod",
  "renewPeriod",
  "transferPeriod",
];

// Extract ICANN status codes from an EPP (camelCase) or RDAP (spaced) status
// field. Spaces/underscores are stripped so both vocabularies match, and RDAP's
// "active" is mapped to the EPP "ok" the other sources emit.
function parseStatusArray(input: unknown): string[] {
  if (!input) return [];
  const raw = Array.isArray(input) ? input.join(" ") : String(input);
  const compact = raw.toLowerCase().replace(/[\s_]+/g, "");
  const matched = new Set(
    KNOWN_STATUSES.filter((s) => compact.includes(s.toLowerCase())),
  );
  if (/(?:^|[^a-z])active(?:[^a-z]|$)/i.test(raw)) matched.add("ok");
  return Array.from(matched);
}

// Open a TCP connection, send the query, and force-close on timeout to free the socket.
async function whoisPort43(
  host: string,
  query: string,
  label: string,
): Promise<string> {
  const conn = await Deno.connect({ hostname: host, port: 43 });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      conn.close();
    } catch { /* ignore */ }
  }, TIMEOUT_MS);
  try {
    const writer = conn.writable.getWriter();
    await writer.write(new TextEncoder().encode(query + "\r\n"));
    writer.releaseLock();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of conn.readable) {
      total += chunk.length;
      if (total > MAX_WHOIS_BYTES) {
        try {
          conn.close();
        } catch { /* ignore */ }
        throw new Error(`${label} response exceeded ${MAX_WHOIS_BYTES} bytes`);
      }
      chunks.push(chunk);
    }
    if (timedOut) throw new Error(`${label} timeout after ${TIMEOUT_MS}ms`);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.length;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  } finally {
    clearTimeout(timer);
    try {
      conn.close();
    } catch { /* already closed */ }
  }
}

// Ask IANA which WHOIS server is authoritative for a given TLD.
async function getWhoisServerForTld(tld: string): Promise<string | null> {
  if (tldWhoisCache.has(tld)) return tldWhoisCache.get(tld) ?? null;
  try {
    const text = await whoisPort43(IANA_WHOIS, tld, "iana-whois");
    const match = text.match(/^whois:\s*(\S+)/im);
    const server = match ? match[1].toLowerCase() : null;
    tldWhoisCache.set(tld, server);
    return server;
  } catch (err) {
    log.warn(`IANA WHOIS lookup failed for .${tld}: ${(err as Error).message}`);
    tldWhoisCache.set(tld, null);
    return null;
  }
}

// Strip WHOIS comment/disclaimer lines and split into key/value entries.
function parseWhoisText(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[%#>]/.test(line) || /^[-=]{2,}$/.test(line)) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9 _\-\/]*?):\s*(.+)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase().replace(/[\s\/]+/g, "_").replace(
      /_+/g,
      "_",
    );
    const value = m[2].trim();
    if (!value || /^redacted/i.test(value)) continue;
    (out[key] ??= []).push(value);
  }
  return out;
}

// Nullify placeholder junk ("", "none", "null", "n/a", "-", "unknown") upstream
// sources emit for missing fields, so it never reaches the database or UI.
function cleanStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || /^(none|null|n\/a|-|unknown)$/i.test(s)) return null;
  return s;
}

// Look up a value by trying any of the candidate keys in order.
function pick(
  data: Record<string, string[]>,
  ...keys: string[]
): string | null {
  for (const k of keys) {
    const v = cleanStr(data[k]?.[0]);
    if (v) return v;
  }
  return null;
}

// Convert a parsed WHOIS dictionary into a normalised WhoisResult.
function whoisDataToResult(
  domain: string,
  data: Record<string, string[]>,
): WhoisResult {
  const registrarLine = pick(data, "registrar", "sponsoring_registrar");
  const registrarName = registrarLine?.replace(/\s*\[.*\]\s*$/, "")?.trim() ||
    null;

  return {
    domainName: pick(data, "domain_name", "domain") ?? domain,
    status: parseStatusArray(
      data.domain_status ?? data.status ?? data.status_code,
    ),
    dnssec: pick(data, "dnssec"),
    dates: {
      creation_date: parseDate(pick(
        data,
        "creation_date",
        "created_date",
        "registered_on",
        "created",
        "registered",
        "registration_date",
        "domain_registration_date",
        "registration_time",
      )),
      updated_date: parseDate(pick(
        data,
        "updated_date",
        "last_updated",
        "last_modified",
        "last_update",
        "modified",
        "domain_last_updated",
      )),
      expiry_date: parseDate(pick(
        data,
        "registry_expiry_date",
        "registrar_registration_expiration_date",
        "expiry_date",
        "expiration_time",
        "expiration_date",
        "expires",
        "expire",
        "expires_on",
        "paid_till",
        "paid_until",
      )),
    },
    registrar: {
      name: registrarName,
      id: pick(data, "registrar_iana_id"),
      url: pick(data, "registrar_url", "url", "registrar_whois_server"),
      registryDomainId: pick(data, "registry_domain_id"),
    },
    whois: {
      name: pick(data, "registrant_name"),
      organization: pick(
        data,
        "registrant_organization",
        "registrant_organisation",
      ),
      street: pick(data, "registrant_street", "registrant_address"),
      city: pick(data, "registrant_city"),
      state: pick(data, "registrant_state_province", "registrant_state"),
      country: pick(data, "registrant_country", "registrant_country_code"),
      postal_code: pick(data, "registrant_postal_code", "registrant_post_code"),
    },
    abuse: {
      email: pick(
        data,
        "registrar_abuse_contact_email",
        "abuse_contact_email",
        "abuse_email",
      ),
      phone: pick(
        data,
        "registrar_abuse_contact_phone",
        "abuse_contact_phone",
        "abuse_phone",
      ),
    },
  };
}

// Returns true if the result has at least the bare minimum to be useful.
function hasUsefulData(r: WhoisResult | null): r is WhoisResult {
  if (!r) return false;
  return Boolean(
    r.dates.expiry_date || r.registrar.name || r.dates.creation_date,
  );
}

// Primary path: query the registry's WHOIS server over TCP/43.
async function tryPort43(domain: string): Promise<WhoisResult | null> {
  const tld = domain.split(".").pop()?.toLowerCase();
  if (!tld) return null;
  const server = await getWhoisServerForTld(tld);
  if (!server) return null;

  try {
    const text = await whoisPort43(server, domain, `whois:${server}`);
    if (!text || text.length < 50) return null;
    let result = whoisDataToResult(domain, parseWhoisText(text));
    if (!hasUsefulData(result)) return null;

    const referral = text.match(
      /(?:^|\n)\s*(?:Registrar WHOIS Server|Whois Server):\s*(\S+)/i,
    );
    if (referral && referral[1] && referral[1].toLowerCase() !== server) {
      try {
        const refText = await whoisPort43(
          referral[1],
          domain,
          `whois:${referral[1]}`,
        );
        const refResult = whoisDataToResult(domain, parseWhoisText(refText));
        if (hasUsefulData(refResult)) {
          result = mergeResults(result, refResult);
        }
      } catch (err) {
        log.debug(
          `Referral WHOIS to ${referral[1]} failed: ${(err as Error).message}`,
        );
      }
    }
    return result;
  } catch (err) {
    log.warn(
      `Port-43 WHOIS to ${server} failed for ${domain}: ${(err as Error).message}`,
    );
    return null;
  }
}

// Merge two WHOIS results. Dates and registrar identity stay anchored to the
// first (authoritative) source so output is deterministic even when the
// registrar-level referral times out or returns slightly different values.
// Contact and abuse fields prefer the second source since registries usually
// do not carry them.
function mergeResults(a: WhoisResult, b: WhoisResult): WhoisResult {
  const preferA = <T>(x: T | null | undefined, y: T | null | undefined) => x ?? y ?? null;
  const preferB = <T>(x: T | null | undefined, y: T | null | undefined) => y ?? x ?? null;
  return {
    domainName: a.domainName ?? b.domainName,
    status: a.status.length ? a.status : b.status,
    dnssec: preferA(a.dnssec, b.dnssec),
    dates: {
      creation_date: preferA(a.dates.creation_date, b.dates.creation_date),
      updated_date: preferA(a.dates.updated_date, b.dates.updated_date),
      expiry_date: preferA(a.dates.expiry_date, b.dates.expiry_date),
    },
    registrar: {
      name: preferA(a.registrar.name, b.registrar.name),
      id: preferA(a.registrar.id, b.registrar.id),
      url: preferA(a.registrar.url, b.registrar.url),
      registryDomainId: preferA(
        a.registrar.registryDomainId,
        b.registrar.registryDomainId,
      ),
    },
    whois: {
      name: preferB(a.whois.name, b.whois.name),
      organization: preferB(a.whois.organization, b.whois.organization),
      street: preferB(a.whois.street, b.whois.street),
      city: preferB(a.whois.city, b.whois.city),
      state: preferB(a.whois.state, b.whois.state),
      country: preferB(a.whois.country, b.whois.country),
      postal_code: preferB(a.whois.postal_code, b.whois.postal_code),
    },
    abuse: {
      email: preferB(a.abuse.email, b.abuse.email),
      phone: preferB(a.abuse.phone, b.abuse.phone),
    },
  };
}

// Lazy-load and cache IANA's RDAP TLD → server map.
async function getRdapBaseForTld(tld: string): Promise<string | null> {
  if (!rdapBootstrap) {
    try {
      const res = await fetch(IANA_BOOTSTRAP_RDAP, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = await res.json();
      const map = new Map<string, string>();
      for (const [tlds, urls] of json.services) {
        for (const t of tlds) map.set(t, String(urls[0]).replace(/\/$/, ""));
      }
      rdapBootstrap = map;
    } catch (err) {
      log.warn(`RDAP bootstrap failed: ${(err as Error).message}`);
      return null;
    }
  }
  return rdapBootstrap.get(tld) ?? null;
}

// Recursively find an entity with a given role.
function findEntityByRole(entities: any[], role: string): any | null {
  if (!Array.isArray(entities)) return null;
  for (const e of entities) {
    if (e?.roles?.includes(role)) return e;
    const sub = findEntityByRole(e?.entities ?? [], role);
    if (sub) return sub;
  }
  return null;
}

// Read a vCard property value (4th element of the matching tuple).
function vcardValue(vcardArray: any, field: string): string | null {
  const data = Array.isArray(vcardArray) ? vcardArray[1] : null;
  if (!Array.isArray(data)) return null;
  const entry = data.find((v) => v?.[0]?.toLowerCase() === field.toLowerCase());
  return cleanStr(entry?.[3]);
}

// Strip an RFC3966 "tel:" prefix from a phone value.
function stripTel(phone: string | null | undefined): string | null {
  if (!phone) return null;
  return phone.startsWith("tel:") ? phone.slice(4) : phone;
}

// Fallback path: query RDAP via IANA's bootstrap registry.
async function tryRdap(domain: string): Promise<WhoisResult | null> {
  const tld = domain.split(".").pop()?.toLowerCase();
  if (!tld) return null;
  const base = await getRdapBaseForTld(tld);
  if (!base) return null;

  try {
    const res = await fetch(`${base}/domain/${encodeURIComponent(domain)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const events = (json.events ?? []) as {
      eventAction: string;
      eventDate: string;
    }[];
    const eventDate = (a: string) => events.find((e) => e.eventAction === a)?.eventDate ?? null;

    const registrar = findEntityByRole(json.entities ?? [], "registrar");
    const registrant = findEntityByRole(json.entities ?? [], "registrant");
    const abuse = findEntityByRole(json.entities ?? [], "abuse");

    const phone = vcardValue(abuse?.vcardArray, "tel");
    // Prefer the registrar's homepage (rel="about") over its RDAP self link.
    // Some registries emit a literal "None" href, which cleanStr drops.
    const regLink = (rel: string) =>
      cleanStr(registrar?.links?.find((l: any) => l?.rel === rel)?.href);
    return {
      domainName: json.ldhName ?? domain,
      status: parseStatusArray(json.status),
      dnssec: json.secureDNS?.delegationSigned ? "signed" : null,
      dates: {
        creation_date: parseDate(eventDate("registration")),
        updated_date: parseDate(
          eventDate("last changed") ?? eventDate("last update"),
        ),
        expiry_date: parseDate(eventDate("expiration")),
      },
      registrar: {
        name: vcardValue(registrar?.vcardArray, "fn"),
        id: registrar?.publicIds?.find((p: any) => /IANA/i.test(p?.type))?.identifier ?? null,
        url: regLink("about") ?? regLink("self"),
        registryDomainId: json.handle ?? null,
      },
      whois: {
        name: vcardValue(registrant?.vcardArray, "fn"),
        organization: vcardValue(registrant?.vcardArray, "org"),
        street: vcardValue(registrant?.vcardArray, "street"),
        city: vcardValue(registrant?.vcardArray, "locality"),
        state: vcardValue(registrant?.vcardArray, "region"),
        country: vcardValue(registrant?.vcardArray, "country-name"),
        postal_code: vcardValue(registrant?.vcardArray, "postal-code"),
      },
      abuse: {
        email: vcardValue(abuse?.vcardArray, "email"),
        phone: stripTel(phone),
      },
    };
  } catch (err) {
    log.warn(`RDAP failed for ${domain}: ${(err as Error).message}`);
    return null;
  }
}

interface WhoDatContact {
  name?: string | null;
  organization?: string | null;
  address?: {
    street?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    country?: string | null;
  } | null;
}

// Map a who-dat contact block into our WhoisContact shape.
function whoDatContact(c: WhoDatContact | null | undefined): WhoisContact {
  const a = c?.address;
  return {
    name: cleanStr(c?.name),
    organization: cleanStr(c?.organization),
    street: cleanStr(a?.street),
    city: cleanStr(a?.city),
    state: cleanStr(a?.state),
    country: cleanStr(a?.country),
    postal_code: cleanStr(a?.postalCode),
  };
}

// Fallback path: who-dat RDAP/WHOIS aggregator. The x-api-key header is sent only
// when WHO_DAT_API_KEY is set, which lifts the public rate limit on our instance.
async function tryWhoDat(domain: string): Promise<WhoisResult | null> {
  const base = (Deno.env.get("WHO_DAT_URL") ?? WHO_DAT_DEFAULT_URL).replace(
    /\/+$/,
    "",
  );
  const key = Deno.env.get("WHO_DAT_API_KEY");
  const headers: Record<string, string> = {
    "User-Agent": WHO_DAT_UA,
    "Accept": "application/json",
  };
  if (key) headers["x-api-key"] = key;

  try {
    const res = await fetch(`${base}/${encodeURIComponent(domain)}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn(`who-dat returned ${res.status} for ${domain}`);
      return null;
    }
    const j = await res.json();
    if (j?.isRegistered === false) return null;
    const reg = j?.registrar ?? {};
    return {
      domainName: j?.domain ?? domain,
      status: parseStatusArray(j?.status),
      dnssec: j?.dnssec?.signed ? "signed" : null,
      dates: {
        creation_date: parseDate(j?.dates?.created),
        updated_date: parseDate(j?.dates?.updated),
        expiry_date: parseDate(j?.dates?.expires),
      },
      registrar: {
        name: cleanStr(reg.name),
        id: cleanStr(reg.ianaId),
        url: cleanStr(reg.url) ?? cleanStr(reg.whoisServer),
        registryDomainId: cleanStr(j?.id),
      },
      whois: whoDatContact(j?.contacts?.registrant),
      abuse: {
        email: cleanStr(reg.abuseEmail),
        phone: stripTel(cleanStr(reg.abusePhone)),
      },
    };
  } catch (err) {
    log.warn(`who-dat failed for ${domain}: ${(err as Error).message}`);
    return null;
  }
}

// Last-resort paid fallback when RDAP, port-43 and who-dat all fail.
async function tryWhoisXml(domain: string): Promise<WhoisResult | null> {
  const apiKey = Deno.env.get("WHOISXML_API_KEY");
  if (!apiKey) return null;
  try {
    const url = new URL("https://www.whoisxmlapi.com/whoisserver/WhoisService");
    url.searchParams.set("apiKey", apiKey);
    url.searchParams.set("outputFormat", "json");
    url.searchParams.set("domainName", domain);
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const json = await res.json();
    const rec = json?.WhoisRecord ?? {};
    const reg = rec.registryData ?? {};
    const r = reg.registrant ?? rec.registrant ?? {};
    const whoisServer = cleanStr(reg.whoisServer);
    return {
      domainName: rec.domainName ?? domain,
      status: parseStatusArray(rec.status ?? reg.status),
      dnssec: null,
      dates: {
        creation_date: parseDate(reg.createdDateNormalized ?? rec.createdDate),
        updated_date: parseDate(reg.updatedDateNormalized ?? rec.updatedDate),
        expiry_date: parseDate(reg.expiresDateNormalized ?? rec.expiresDate),
      },
      registrar: {
        name: cleanStr(rec.registrarName ?? reg.registrarName),
        id: cleanStr(rec.registrarIANAID),
        url: whoisServer ? `https://${whoisServer}` : null,
        registryDomainId: cleanStr(reg.registryDomainId),
      },
      whois: {
        name: r.name ?? null,
        organization: r.organization ?? null,
        street: r.street1 ?? null,
        city: r.city ?? null,
        state: r.state ?? null,
        country: r.countryCode ?? r.country ?? null,
        postal_code: r.postalCode ?? null,
      },
      abuse: {
        email: rec.contactEmail ?? null,
        phone: null,
      },
    };
  } catch (err) {
    log.warn(`WhoisXML failed for ${domain}: ${(err as Error).message}`);
    return null;
  }
}

// Resolve WHOIS data via RDAP, then port-43, then who-dat, then WhoisXML.
export async function getWhoisInfo(
  domain: string,
): Promise<WhoisResult | null> {
  const trimmed = normalizeDomain(domain);
  if (!trimmed) {
    log.warn(`Rejecting invalid WHOIS domain: ${domain}`);
    return null;
  }

  const sources: [string, () => Promise<WhoisResult | null>][] = [
    ["rdap", () => tryRdap(trimmed)],
    ["port-43", () => tryPort43(trimmed)],
    ["who-dat", () => tryWhoDat(trimmed)],
    ["whoisxml", () => tryWhoisXml(trimmed)],
  ];

  let best: WhoisResult | null = null;
  for (const [name, fn] of sources) {
    try {
      const result = await fn();
      if (hasUsefulData(result)) {
        log.success(`WHOIS via ${name} for ${trimmed}`);
        if (!best) best = result;
        else best = mergeResults(best, result!);
        if (best.dates.expiry_date && best.registrar.name) return best;
      }
    } catch (err) {
      log.warn(
        `Source ${name} threw for ${trimmed}: ${(err as Error).message}`,
      );
    }
  }
  return best;
}
