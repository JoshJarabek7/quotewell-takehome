import { MONEY_MULT, MONTHS, normalizeState, type Candidate } from "./normalize";
import { RecordSchema, type RecordPayload } from "./schema";
import type { Flag } from "./report";

export interface GroundResult {
  payload: RecordPayload | null;
  errors: string[];
  flags: Flag[];
}

const ordinal = (n: number): string => {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  const suffix = ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
};

/**
 * Every plausible way the ISO date could have been written in the source.
 * Invariant (pinned by a unit test): any form normalizeDate accepts must be
 * verifiable here — otherwise a correctly extracted date gets called invented.
 */
export function dateRepresentations(iso: string): string[] {
  const [ys, ms, ds] = iso.split("-");
  const y = Number(ys), m = Number(ms), d = Number(ds);
  const yy = String(y % 100).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  const month = MONTHS[m - 1] ?? "";
  const mon3 = month.slice(0, 3);
  const reps = [
    iso,
    // month-first numeric, slash and dash
    `${m}/${d}/${y}`, `${mm}/${dd}/${y}`, `${m}/${d}/${yy}`, `${mm}/${dd}/${yy}`,
    `${m}-${d}-${y}`, `${mm}-${dd}-${y}`, `${m}-${d}-${yy}`, `${mm}-${dd}-${yy}`,
    // day-first numeric (normalizeDate accepts these when unambiguous)
    `${d}/${m}/${y}`, `${dd}/${mm}/${y}`, `${d}/${m}/${yy}`,
    // written months, with and without ordinals / abbreviation dot
    `${month} ${d}, ${y}`, `${month} ${d} ${y}`, `${month} ${dd}, ${y}`,
    `${month} ${ordinal(d)}, ${y}`, `${month} ${ordinal(d)} ${y}`,
    `${mon3} ${d}, ${y}`, `${mon3} ${d} ${y}`, `${mon3}. ${d}, ${y}`, `${mon3}. ${d} ${y}`,
    `${mon3} ${ordinal(d)}, ${y}`, `${mon3}. ${ordinal(d)}, ${y}`,
  ];
  return [...new Set(reps)];
}

/** Sender-local calendar date from the RFC-style Date header, read textually —
 *  round-tripping through an epoch instant shifts the date near month boundaries. */
function parseHeaderDate(source: string): { y: number; m: number; d: number } | null {
  const line = /^Date:\s*(.+)$/m.exec(source)?.[1];
  if (!line) return null;
  const m = /(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})/.exec(line);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const monthIdx = MONTHS.findIndex((mo) => mo.startsWith(m[2]!.toLowerCase().slice(0, 3)));
  const d = Number(m[1]);
  if (monthIdx === -1 || d < 1 || d > 31) return null;
  return { y: Number(m[3]), m: monthIdx + 1, d };
}

function firstOfNextMonth(anchor: { y: number; m: number }): string {
  const y = anchor.m === 12 ? anchor.y + 1 : anchor.y;
  const m = anchor.m === 12 ? 1 : anchor.m + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

const RELATIVE_FIRST_OF_MONTH = /(?:first|1st|beginning)\s+of\s+(?:next|the\s+coming|the\s+following)\s+month/i;

interface MoneyCandidate {
  value: number;
  index: number;
  /** true when the literal is unambiguously money ($-prefixed or scale-suffixed);
   *  plain comma-grouped numbers can ground a value but don't rank as "newest". */
  marked: boolean;
}

/** Money-like literals in the source, in text order (top of thread = newest content). */
function moneyCandidates(source: string): MoneyCandidate[] {
  const found: MoneyCandidate[] = [];
  const push = (value: number, index: number, marked: boolean) => {
    if (Number.isFinite(value) && value > 0) found.push({ value: Math.round(value), index, marked });
  };
  // $-prefixed with optional scale suffix: $4.2M, $950k, $2,500,000
  for (const m of source.matchAll(/\$\s*([\d,]+(?:\.\d+)?)\s*(mm|bn|thousand|million|billion|k|m|b)?\b/gi)) {
    const base = Number((m[1] ?? "").replace(/,/g, ""));
    push(base * (MONEY_MULT[(m[2] ?? "").toLowerCase()] ?? 1), m.index ?? 0, true);
  }
  // scale-suffixed without $: "1.2 million", "950k"
  for (const m of source.matchAll(/(?<![\w$.,])([\d.]+)\s*(thousand|million|billion|[km])\b/gi)) {
    const base = Number(m[1] ?? "");
    push(base * (MONEY_MULT[(m[2] ?? "").toLowerCase()] ?? 1), m.index ?? 0, true);
  }
  // digit-grouped plain numbers: 2,500,000
  for (const m of source.matchAll(/(?<![\d,.])(\d{1,3}(?:,\d{3})+)(?![\d,])/g)) {
    push(Number((m[1] ?? "").replace(/,/g, "")), m.index ?? 0, false);
  }
  // one entry per distinct value at its earliest (= newest) mention; a value is
  // "marked" if any of its mentions were unambiguously money
  found.sort((a, b) => a.index - b.index);
  const byValue = new Map<number, MoneyCandidate>();
  for (const c of found) {
    const existing = byValue.get(c.value);
    if (!existing) byValue.set(c.value, { ...c });
    else existing.marked = existing.marked || c.marked;
  }
  return [...byValue.values()];
}

const fmtAddr = (a: Candidate["mailingAddress"]) => `${a.street}, ${a.city}, ${a.state} ${a.zip}`;

/**
 * Verify extracted literals against the source email. The extractor confidently
 * states things the source does not support; nothing it says is trusted until
 * a normalized form of it is found in (or derivable from) the source text.
 */
export function groundRecord(candidate: Candidate, source: string): GroundResult {
  const errors: string[] = [];
  const flags: Flag[] = [];
  const lower = source.toLowerCase();
  let { mailingAddress, annualRevenue } = candidate;

  // contactEmail — required literal; must appear verbatim
  if (!lower.includes(candidate.contactEmail)) {
    errors.push(
      `contactEmail "${candidate.contactEmail}" does not appear in the source email — cannot verify, refusing to submit`,
    );
  }

  // mailing address — correct only when the source explicitly directs *mail* to a
  // PO Box (a PO Box merely appearing somewhere, e.g. in a broker's signature,
  // must not rewrite the insured's address). The assignment sanctions correcting
  // extraction mistakes programmatically; the correction still only uses text
  // from the source email itself.
  const poBoxMailDirective = /\bmail\w*[\s\S]{0,120}?P\.?\s*O\.?\s*Box\s+\d+/i.test(source);
  const streetIsPoBox = /\bP\.?\s*O\.?\s*Box\b/i.test(mailingAddress.street);
  if (poBoxMailDirective && !streetIsPoBox) {
    const m =
      /\b(P\.?\s*O\.?\s*Box\s+\d+)\s*,\s*([A-Za-z][A-Za-z .'-]*?)\s*,\s*([A-Za-z][A-Za-z .]*?)\.?,?\s+(\d{5})(?:-\d{4})?\b/i.exec(
        source,
      );
    const state = m && m[3] ? normalizeState(m[3]) : null;
    if (m && m[1] && m[2] && m[4] && state) {
      const corrected = {
        street: m[1].replace(/\s+/g, " "),
        city: m[2].trim(),
        state: state.code,
        zip: m[4],
      };
      flags.push({
        code: "mailing_address_corrected_to_po_box",
        detail: `source directs mail to a PO Box; replaced extracted "${fmtAddr(mailingAddress)}" with "${fmtAddr(corrected)}" parsed from the source`,
      });
      mailingAddress = corrected;
    } else {
      errors.push(
        "mailingAddress: source explicitly directs mail to a PO Box but the extracted street is not a PO Box, and the PO Box address could not be parsed cleanly from the source — needs human review",
      );
    }
  }

  // zip — required literal; must appear as its own token (a raw substring test
  // could be satisfied by digits inside a phone or account number)
  if (!new RegExp(`\\b${mailingAddress.zip}(?:-\\d{4})?\\b`).test(source)) {
    errors.push(`mailingAddress.zip "${mailingAddress.zip}" does not appear in the source email — cannot verify`);
  }
  const zipsInSource = [...new Set((source.match(/\b\d{5}(?:-\d{4})?\b/g) ?? []).map((z) => z.slice(0, 5)))];
  if (zipsInSource.length > 1) {
    flags.push({
      code: "multiple_zips_in_source",
      detail: `source contains ${zipsInSource.length} zips (${zipsInSource.join(", ")}); submitted ${mailingAddress.zip}`,
    });
  }

  // annualRevenue — optional, and the spec says do not guess. Ungrounded → null.
  if (annualRevenue !== null) {
    const cands = moneyCandidates(source);
    const rev = annualRevenue;
    const match = cands.find((c) => Math.abs(c.value - rev) < 1);
    if (!match) {
      flags.push({
        code: "revenue_ungrounded_nulled",
        detail: `extracted annualRevenue ${rev} is not supported by the source ${
          cands.length > 0 ? `(amounts in source: ${cands.map((c) => c.value).join(", ")})` : "(no dollar amounts in source)"
        } — set to null per "do not guess"`,
      });
      annualRevenue = null;
    } else {
      // Newest-wins among unambiguous money literals only: in reply-quoted
      // threads, earlier text position = newer content. Plain grouped numbers
      // ("1,200 units") are excluded so they can't hijack the ranking.
      const marked = cands.filter((c) => c.marked);
      const newest = marked[0];
      if (match.marked && newest && marked.length > 1) {
        if (match.value === newest.value) {
          flags.push({
            code: "revenue_multiple_candidates_kept_newest",
            detail: `source mentions several amounts (${marked.map((c) => c.value).join(", ")}); extracted value matches the newest (topmost in the thread) — kept`,
          });
        } else {
          flags.push({
            code: "revenue_stale_candidate_nulled",
            detail: `extracted ${rev} matches an older mention in the thread; the newest amount is ${newest.value} — set to null for human confirmation`,
          });
          annualRevenue = null;
        }
      }
    }
  }

  // effectiveDate — required. Grounded if a written form appears in the source,
  // or if it exactly resolves a relative phrase anchored to the email's Date header.
  const reps = dateRepresentations(candidate.effectiveDate);
  const dateGrounded = reps.some((r) => lower.includes(r.toLowerCase()));
  if (!dateGrounded) {
    const header = parseHeaderDate(source);
    if (RELATIVE_FIRST_OF_MONTH.test(source) && header) {
      const resolved = firstOfNextMonth(header);
      const month = MONTHS[header.m - 1] ?? "";
      const anchor = `${header.d} ${month.charAt(0).toUpperCase()}${month.slice(1)} ${header.y}`;
      if (resolved === candidate.effectiveDate) {
        flags.push({
          code: "effective_date_inferred_from_relative_phrase",
          detail: `no literal date in source; "first of next month" anchored to the email Date header (${anchor}) resolves to ${resolved}, matching the extracted value — accepted with this flag`,
        });
      } else {
        errors.push(
          `effectiveDate ${candidate.effectiveDate}: not in the source, and the source's relative phrase resolves to ${resolved} instead — refusing to submit`,
        );
      }
    } else {
      errors.push(
        `effectiveDate ${candidate.effectiveDate}: does not appear in the source email in any recognized form and nothing anchors it — the extractor appears to have invented it; a confirmed date is needed before this can be submitted`,
      );
    }
  }

  if (errors.length > 0) return { payload: null, errors, flags };

  const parsed = RecordSchema.safeParse({ ...candidate, mailingAddress, annualRevenue });
  if (!parsed.success) {
    // "schema." prefix distinguishes a mapping gap on our side from a genuine
    // grounding failure — the pipeline reports them differently.
    return {
      payload: null,
      errors: parsed.error.issues.map((i) => `schema.${i.path.join(".")}: ${i.message}`),
      flags,
    };
  }
  return { payload: parsed.data, errors: [], flags };
}
