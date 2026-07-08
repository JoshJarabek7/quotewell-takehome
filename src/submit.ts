import { tryJson } from "./parse";
import type { RecordPayload } from "./schema";
import type { Flag } from "./report";

const ATTEMPT_TIMEOUT_MS = 10_000; // the AMS hangs; an unbounded await is data loss waiting to happen
const MAX_ATTEMPTS = 8;
const RECORD_BUDGET_MS = 120_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
const RETRY_AFTER_MIN_S = 0.5;
const RETRY_AFTER_MAX_S = 15;

export type SubmitResult =
  | { ok: true; recordId: string; attempts: number; flags: Flag[] }
  | { ok: false; stage: "submit" | "confirm"; reason: string; details?: unknown; attempts: number; flags: Flag[] };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fullJitterBackoff = (attempt: number) =>
  Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
const fmtS = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Field-level comparison of what we sent vs what the AMS actually stored. */
function diffPayload(sent: RecordPayload, stored: unknown): string[] {
  const diffs: string[] = [];
  const s = (typeof stored === "object" && stored !== null ? stored : {}) as Record<string, unknown>;
  const check = (field: string, want: unknown, got: unknown) => {
    if (!Object.is(want, got)) diffs.push(`${field}: submitted ${JSON.stringify(want)}, AMS has ${JSON.stringify(got)}`);
  };
  check("insuredName", sent.insuredName, s.insuredName);
  check("dba", sent.dba, s.dba);
  const addr = (typeof s.mailingAddress === "object" && s.mailingAddress !== null ? s.mailingAddress : {}) as Record<string, unknown>;
  for (const k of ["street", "city", "state", "zip"] as const) {
    check(`mailingAddress.${k}`, sent.mailingAddress[k], addr[k]);
  }
  check("lineOfBusiness", sent.lineOfBusiness, s.lineOfBusiness);
  check("effectiveDate", sent.effectiveDate, s.effectiveDate);
  check("annualRevenue", sent.annualRevenue, s.annualRevenue);
  check("contactEmail", sent.contactEmail, s.contactEmail);
  return diffs;
}

export type ConfirmCheck =
  | { kind: "match" }
  | { kind: "mismatch"; diffs: string[] }
  | { kind: "not_found" }
  | { kind: "unavailable" }; // couldn't check ≠ 404 — the report must not claim a 404 that never happened

/** GET the stored record and verify it is exactly what we submitted. Documented reliable; one retry for politeness. */
export async function confirmRecord(recordId: string, payload: RecordPayload, baseUrl: string): Promise<ConfirmCheck> {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/records/${encodeURIComponent(recordId)}`, {
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (res.status === 404) return { kind: "not_found" };
      if (!res.ok) continue;
      const stored: unknown = await res.json();
      const diffs = diffPayload(payload, stored);
      return diffs.length === 0 ? { kind: "match" } : { kind: "mismatch", diffs };
    } catch {
      // fall through to the retry
    }
  }
  return { kind: "unavailable" }; // unverifiable = unconfirmed; the caller's retry loop is idempotent
}

/**
 * Submit one record and only report success once a GET proves it persisted
 * with the exact fields we sent. A 2xx from this AMS is a claim, not a fact.
 *
 * Retrying blind writes is only safe because every attempt carries the same
 * Idempotency-Key: the AMS may persist a record and still answer with an
 * error, a hang, or a mangled body, and the key is what turns "try again"
 * from "maybe create a duplicate" into "give me back the original".
 */
export async function submitWithConfirm(
  payload: RecordPayload,
  idemKey: string,
  label: string,
  baseUrl: string,
): Promise<SubmitResult> {
  const flags: Flag[] = [];
  const started = Date.now();
  let lastNote = "no attempts made";
  const log = (attempt: number, msg: string) => console.log(`  [${label}] attempt ${attempt}/${MAX_ATTEMPTS}: ${msg}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (Date.now() - started > RECORD_BUDGET_MS) {
      return {
        ok: false,
        stage: "submit",
        reason: `per-record time budget (${RECORD_BUDGET_MS / 1000}s) exhausted; last state: ${lastNote}. Idempotency key is stable — a later rerun is safe.`,
        attempts: attempt - 1,
        flags,
      };
    }

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/v1/records`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": idemKey },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as Error;
      lastNote =
        e.name === "TimeoutError" || e.name === "AbortError"
          ? `no response within ${ATTEMPT_TIMEOUT_MS / 1000}s (hung request aborted)`
          : `network error: ${e.message}`;
      const wait = fullJitterBackoff(attempt);
      log(attempt, `${lastNote} — backing off ${fmtS(wait)}`);
      await sleep(wait);
      continue;
    }

    if (res.status === 429) {
      await safeText(res);
      const raHeader = res.headers.get("retry-after");
      const ra = Number(raHeader);
      const usable = raHeader !== null && Number.isFinite(ra) && ra > 0;
      const waitS = usable ? Math.min(Math.max(ra, RETRY_AFTER_MIN_S), RETRY_AFTER_MAX_S) : 1;
      lastNote = "rate-limited (429)";
      log(
        attempt,
        usable
          ? `429 rate-limited — honoring Retry-After: waiting ${waitS}s`
          : `429 rate-limited — no usable Retry-After header; waiting ${waitS}s`,
      );
      await sleep(waitS * 1000);
      continue;
    }

    if (res.status === 400) {
      const body = await safeText(res);
      log(attempt, "400 bad request — not retrying");
      return { ok: false, stage: "submit", reason: "AMS rejected the request as malformed (400)", details: tryJson(body) ?? body, attempts: attempt, flags };
    }

    if (res.status === 422) {
      const body = tryJson(await safeText(res));
      log(attempt, "422 validation failed — not retrying (payload was pre-normalized; this is a schema gap on our side)");
      return {
        ok: false,
        stage: "submit",
        reason: "AMS validation failed (422); normalization runs before submission, so this indicates a gap in our schema mapping",
        details: body,
        attempts: attempt,
        flags,
      };
    }

    if (res.status >= 500) {
      await safeText(res);
      lastNote = `server error (${res.status})`;
      const wait = fullJitterBackoff(attempt);
      log(attempt, `${res.status} server error — backing off ${fmtS(wait)}`);
      await sleep(wait);
      continue;
    }

    if (res.ok) {
      const text = await safeText(res);
      const body = tryJson(text) as { recordId?: unknown } | undefined;
      const recordId = typeof body?.recordId === "string" && body.recordId.length > 0 ? body.recordId : null;

      if (!recordId) {
        // The write may or may not have persisted. Same key makes resubmission safe.
        flags.push({
          code: "malformed_2xx_body",
          detail: `attempt ${attempt}: ${res.status} with unusable body (${JSON.stringify(text.slice(0, 120))}) — resubmitted with the same idempotency key`,
        });
        lastNote = `2xx with unusable body`;
        const wait = fullJitterBackoff(attempt);
        log(attempt, `${res.status} but body unusable — resubmitting with same key in ${fmtS(wait)}`);
        await sleep(wait);
        continue;
      }

      log(attempt, `${res.status} accepted, recordId ${recordId} — verifying via GET`);
      const check = await confirmRecord(recordId, payload, baseUrl);
      if (check.kind === "match") {
        log(attempt, `GET confirms ${recordId} matches the submitted payload — CONFIRMED`);
        return { ok: true, recordId, attempts: attempt, flags };
      }
      if (check.kind === "mismatch") {
        return {
          ok: false,
          stage: "confirm",
          reason: `AMS stored a record under ${recordId} that does not match what we submitted — not counting it as confirmed`,
          details: check.diffs,
          attempts: attempt,
          flags,
        };
      }
      // not_found: the 2xx lied about persistence. unavailable: we couldn't
      // check. Either way the record is unconfirmed; retry with the same key.
      const note =
        check.kind === "not_found"
          ? `AMS claimed ${recordId} but GET returned 404`
          : `AMS claimed ${recordId} but the confirmation GET was unreachable`;
      flags.push({ code: `accepted_but_${check.kind}`, detail: `attempt ${attempt}: ${note} — retried` });
      lastNote = note;
      const wait = fullJitterBackoff(attempt);
      log(attempt, `${note} — retrying in ${fmtS(wait)}`);
      await sleep(wait);
      continue;
    }

    // anything else (3xx etc.) — anomalous; retry
    await safeText(res);
    lastNote = `unexpected status ${res.status}`;
    const wait = fullJitterBackoff(attempt);
    log(attempt, `unexpected ${res.status} — backing off ${fmtS(wait)}`);
    await sleep(wait);
  }

  return {
    ok: false,
    stage: "submit",
    reason: `gave up after ${MAX_ATTEMPTS} attempts; last state: ${lastNote}. Nothing was silently lost: the idempotency key is derived from the source email, so a rerun resumes safely.`,
    attempts: MAX_ATTEMPTS,
    flags,
  };
}

/** Full listing for reconciliation. The run's exit code depends on this, so it
 *  gets the same two-try treatment as confirmRecord. */
export async function listRecords(baseUrl: string): Promise<unknown[] | null> {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/records`, { signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
      if (!res.ok) continue;
      const body = (await res.json()) as { records?: unknown } | unknown[];
      if (Array.isArray(body)) return body;
      if (Array.isArray((body as { records?: unknown })?.records)) return (body as { records: unknown[] }).records;
    } catch {
      // fall through to the retry
    }
  }
  return null;
}
