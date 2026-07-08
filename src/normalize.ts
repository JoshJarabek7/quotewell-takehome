import type { Flag } from "./report";                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       
import { EMAIL_RE, LINES_OF_BUSINESS, type LineOfBusiness } from "./schema";

const USPS_CODES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(
    " ",
  ),
);

// Keys are full state names lowercased with spaces stripped ("newyork").
const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", newhampshire: "NH", newjersey: "NJ",
  newmexico: "NM", newyork: "NY", northcarolina: "NC", northdakota: "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", rhodeisland: "RI", southcarolina: "SC",
  southdakota: "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", westvirginia: "WV", wisconsin: "WI", wyoming: "WY",
  districtofcolumbia: "DC",
};

// AP-style print abbreviations that are NOT a unique prefix of any single state
// name, so the prefix rule below can't resolve them ("Ala." could open Alabama
// or Alaska; "Miss." Mississippi or Missouri). Standardized forms only.
const STATE_AP_EXCEPTIONS: Record<string, string> = {
  ala: "AL", miss: "MS", wva: "WV", nmex: "NM", ndak: "ND", sdak: "SD",
};

/**
 * Resolve a written state to its USPS code without guessing:
 * exact code ("TX", "n.y.") → exact full name → unique prefix of exactly one
 * state name ("tex", "calif", "ore") → AP exception table. Anything ambiguous
 * or unknown returns null and the record fails for human review — a fuzzy
 * closest-match would risk silently submitting the wrong state.
 */
export function normalizeState(input: string): { code: string; mapped: boolean } | null {
  const trimmed = input.trim();
  const key = trimmed.toLowerCase().replace(/[.\s]/g, "");
  if (key.length === 2 && USPS_CODES.has(key.toUpperCase())) {
    return { code: key.toUpperCase(), mapped: trimmed !== key.toUpperCase() };
  }
  const exact = STATE_NAMES[key];
  if (exact) return { code: exact, mapped: true };
  const exception = STATE_AP_EXCEPTIONS[key];
  if (exception) return { code: exception, mapped: true };
  if (key.length >= 3 && /^[a-z]+$/.test(key)) {
    const matches = Object.keys(STATE_NAMES).filter((name) => name.startsWith(key));
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only) return { code: STATE_NAMES[only] as string, mapped: true };
  }
  return null;
}

export function normalizeZip(input: string): { zip: string; truncated: boolean } | null {
  const m = /^(\d{5})(?:-\d{4})?$/.exec(input.trim());
  if (!m || !m[1]) return null;
  return { zip: m[1], truncated: m[0].length > 5 };
}

export const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
] as const;

function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const toIso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Interpret a numeric a<sep>b<sep>year form, defaulting to US month-first. */
function fromNumericParts(a: number, b: number, yearRaw: string, original: string): { iso: string; flags: Flag[] } | null {
  const flags: Flag[] = [];
  let y = Number(yearRaw);
  if (yearRaw.length === 2) {
    y += 2000;
    flags.push({ code: "two_digit_year_expanded", detail: `"${original}": interpreted year as ${y}` });
  }
  let month = a;
  let day = b;
  if (a > 12 && b <= 12) {
    month = b; // unambiguously day-first
    day = a;
    flags.push({ code: "date_interpreted_day_first", detail: `"${original}": first component > 12, read as day/month/year` });
  } else if (a <= 12 && b <= 12 && a !== b) {
    flags.push({ code: "date_assumed_month_first", detail: `"${original}" is ambiguous; assumed US month/day/year` });
  }
  return isValidYmd(y, month, day) ? { iso: toIso(y, month, day), flags } : null;
}

export function normalizeDate(input: string): { iso: string; flags: Flag[] } | null {
  // LLMs habitually emit full ISO datetimes for date fields; keep just the date part.
  const s = input.trim().replace(/^(\d{4}-\d{1,2}-\d{1,2})[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?$/, "$1");

  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (isoMatch) {
    const y = Number(isoMatch[1]), m = Number(isoMatch[2]), d = Number(isoMatch[3]);
    return isValidYmd(y, m, d) ? { iso: toIso(y, m, d), flags: [] } : null;
  }

  const numericMatch = /^(\d{1,2})([/-])(\d{1,2})\2(\d{2}|\d{4})$/.exec(s);
  if (numericMatch && numericMatch[1] && numericMatch[3] && numericMatch[4]) {
    return fromNumericParts(Number(numericMatch[1]), Number(numericMatch[3]), numericMatch[4], s);
  }

  const nameMatch = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(s);
  if (nameMatch && nameMatch[1] && nameMatch[2] && nameMatch[3]) {
    const prefix = nameMatch[1].toLowerCase();
    const monthIdx = MONTHS.findIndex((mo) => mo.startsWith(prefix) && prefix.length >= 3);
    if (monthIdx !== -1) {
      const y = Number(nameMatch[3]);
      const d = Number(nameMatch[2]);
      return isValidYmd(y, monthIdx + 1, d) ? { iso: toIso(y, monthIdx + 1, d), flags: [] } : null;
    }
  }

  return null;
}

const LOB_SYNONYMS: Record<string, LineOfBusiness> = {
  "general liability": "general_liability",
  gl: "general_liability",
  cgl: "general_liability",
  "commercial general liability": "general_liability",
  "commercial property": "commercial_property",
  property: "commercial_property",
  "workers compensation": "workers_compensation",
  "workers comp": "workers_compensation",
  "work comp": "workers_compensation",
  "workmans compensation": "workers_compensation",
  wc: "workers_compensation",
  "commercial auto": "commercial_auto",
  "business auto": "commercial_auto",
  auto: "commercial_auto",
  bop: "bop",
  "business owners policy": "bop",
  "business owner policy": "bop",
};

export function normalizeLob(input: string): { lob: LineOfBusiness; mapped: boolean } | null {
  const canonical = (LINES_OF_BUSINESS as readonly string[]).find((l) => l === input);
  if (canonical) return { lob: canonical as LineOfBusiness, mapped: false };
  const key = input
    .toLowerCase()
    .replace(/['’]/g, "") // "Business Owner's Policy" → "business owners policy"
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const lob = LOB_SYNONYMS[key];
  return lob ? { lob, mapped: true } : null;
}

/** Scale suffixes for money literals; shared with the grounding scanner. */
export const MONEY_MULT: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
};

/** "$4.2M", "950k", "2,500,000", "1.2 million" → integer USD. */
export function parseMoney(input: string): number | null {
  const m = /^\$?\s*([\d,]+(?:\.\d+)?)\s*(mm|bn|thousand|million|billion|k|m|b)?\.?$/i.exec(input.trim());
  if (!m || !m[1]) return null;
  const base = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const suffix = (m[2] ?? "").toLowerCase();
  const mult = suffix === "" ? 1 : MONEY_MULT[suffix];
  return mult === undefined ? null : Math.round(base * mult);
}

/** Pre-grounding, pre-schema shape: all fields normalized but not yet verified against the source. */
export interface Candidate {
  insuredName: string;
  dba: string | null;
  mailingAddress: { street: string; city: string; state: string; zip: string };
  lineOfBusiness: LineOfBusiness;
  effectiveDate: string;
  annualRevenue: number | null;
  contactEmail: string;
}

export interface NormalizeResult {
  candidate: Candidate | null;
  errors: string[];
  flags: Flag[];
}

export function normalizeRecord(value: unknown): NormalizeResult {
  const errors: string[] = [];
  const flags: Flag[] = [];

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { candidate: null, errors: ["model output is not a JSON object"], flags };
  }
  const obj = value as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);

  const insuredName = str(obj.insuredName);
  if (!insuredName) errors.push("insuredName: missing or empty");

  // dba is optional: a blank string is a natural model encoding of "none".
  let dba: string | null = null;
  if (obj.dba !== undefined && obj.dba !== null) {
    if (typeof obj.dba !== "string") {
      errors.push("dba: present but not a string");
    } else {
      dba = str(obj.dba);
      if (dba === null && obj.dba.length > 0) {
        flags.push({ code: "dba_blank_treated_as_null", detail: `dba ${JSON.stringify(obj.dba)} treated as "none"` });
      }
    }
  }

  let mailingAddress: Candidate["mailingAddress"] | null = null;
  const rawAddr = obj.mailingAddress;
  if (typeof rawAddr !== "object" || rawAddr === null) {
    errors.push("mailingAddress: missing or not an object");
  } else {
    const a = rawAddr as Record<string, unknown>;
    const street = str(a.street);
    const city = str(a.city);
    const stateRaw = str(a.state);
    const zipRaw = str(a.zip) ?? (typeof a.zip === "number" ? String(a.zip) : null);
    if (!street) errors.push("mailingAddress.street: missing or empty");
    if (!city) errors.push("mailingAddress.city: missing or empty");

    let state: string | null = null;
    if (!stateRaw) {
      errors.push("mailingAddress.state: missing or empty");
    } else {
      const st = normalizeState(stateRaw);
      if (!st) errors.push(`mailingAddress.state: unrecognized or ambiguous state "${stateRaw}" — not guessing`);
      else {
        state = st.code;
        if (st.mapped && stateRaw.toUpperCase() !== st.code) {
          flags.push({ code: "state_normalized", detail: `"${stateRaw}" → "${st.code}"` });
        }
      }
    }

    let zip: string | null = null;
    if (!zipRaw) {
      errors.push("mailingAddress.zip: missing or empty");
    } else {
      const z = normalizeZip(zipRaw);
      if (!z) errors.push(`mailingAddress.zip: unusable zip "${zipRaw}"`);
      else {
        zip = z.zip;
        if (z.truncated) flags.push({ code: "zip_truncated_to_5", detail: `"${zipRaw}" → "${z.zip}"` });
      }
    }

    if (street && city && state && zip) mailingAddress = { street, city, state, zip };
  }

  let lineOfBusiness: LineOfBusiness | null = null;
  const lobRaw = str(obj.lineOfBusiness);
  if (!lobRaw) {
    errors.push("lineOfBusiness: missing or empty");
  } else {
    const lob = normalizeLob(lobRaw);
    if (!lob) errors.push(`lineOfBusiness: cannot map "${lobRaw}" to a known line of business`);
    else {
      lineOfBusiness = lob.lob;
      if (lob.mapped) flags.push({ code: "lob_synonym_mapped", detail: `"${lobRaw}" → "${lob.lob}"` });
    }
  }

  let effectiveDate: string | null = null;
  const dateRaw = str(obj.effectiveDate);
  if (!dateRaw) {
    errors.push("effectiveDate: missing or empty");
  } else {
    const d = normalizeDate(dateRaw);
    if (!d) errors.push(`effectiveDate: unparseable date "${dateRaw}"`);
    else {
      effectiveDate = d.iso;
      flags.push(...d.flags);
      if (d.iso !== dateRaw) flags.push({ code: "date_normalized", detail: `"${dateRaw}" → "${d.iso}"` });
    }
  }

  // annualRevenue is optional and the spec says do not guess: an unusable value
  // demotes to null-with-flag rather than failing the whole record.
  let annualRevenue: number | null = null;
  if (obj.annualRevenue !== undefined && obj.annualRevenue !== null) {
    if (typeof obj.annualRevenue === "number" && Number.isFinite(obj.annualRevenue) && obj.annualRevenue >= 0) {
      annualRevenue = obj.annualRevenue;
    } else if (typeof obj.annualRevenue === "string") {
      const parsed = parseMoney(obj.annualRevenue);
      if (parsed === null) {
        flags.push({
          code: "revenue_unparseable_nulled",
          detail: `annualRevenue ${JSON.stringify(obj.annualRevenue)} is not a dollar amount — treated as not stated (null)`,
        });
      } else {
        annualRevenue = parsed;
        flags.push({ code: "revenue_parsed_from_string", detail: `"${obj.annualRevenue}" → ${parsed}` });
      }
    } else {
      flags.push({
        code: "revenue_unparseable_nulled",
        detail: `annualRevenue ${JSON.stringify(obj.annualRevenue)} is not a number, money string, or null — treated as not stated (null)`,
      });
    }
  }

  let contactEmail: string | null = null;
  const emailRaw = str(obj.contactEmail);
  if (!emailRaw || !EMAIL_RE.test(emailRaw.toLowerCase())) {
    errors.push(`contactEmail: missing or invalid ("${emailRaw ?? ""}")`);
  } else {
    contactEmail = emailRaw.toLowerCase();
    if (contactEmail !== emailRaw) {
      flags.push({ code: "email_lowercased", detail: `"${emailRaw}" → "${contactEmail}"` });
    }
  }

  if (errors.length > 0 || !insuredName || !mailingAddress || !lineOfBusiness || !effectiveDate || !contactEmail) {
    return { candidate: null, errors, flags };
  }
  return {
    candidate: { insuredName, dba, mailingAddress, lineOfBusiness, effectiveDate, annualRevenue, contactEmail },
    errors,
    flags,
  };
}
