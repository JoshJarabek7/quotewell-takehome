import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractEmail } from "./extract";
import { parseModelOutput } from "./parse";
import { normalizeRecord } from "./normalize";
import { groundRecord } from "./ground";
import { listRecords, submitWithConfirm } from "./submit";
import {
  ARTIFACTS_DIR,
  printSummary,
  reconciliationClean,
  writeRunReport,
  type Flag,
  type Outcome,
  type Reconciliation,
  type Stage,
} from "./report";
import type { RecordPayload } from "./schema";

const BASE_URL = process.env.AMS_BASE_URL ?? "http://localhost:8472";
const INBOX_DIR = "inbox";

interface Prepared {
  emailId: string;
  idemKey: string;
  payload: RecordPayload | null;
  failure: Outcome | null;
  flags: Flag[];
}

// One definition of "the same logical record", used by both the pre-submit
// duplicate check and reconciliation — if they diverged, dedup would silently rot.
const identityKey = (insuredName: unknown, lineOfBusiness: unknown, effectiveDate: unknown) =>
  [String(insuredName ?? "").toLowerCase().trim(), String(lineOfBusiness ?? ""), String(effectiveDate ?? "")].join("|");

const logicalIdentity = (p: RecordPayload) => identityKey(p.insuredName, p.lineOfBusiness, p.effectiveDate);

async function prepare(file: string): Promise<Prepared> {
  const emailId = file.replace(/\.txt$/, "");
  const raw = await readFile(path.join(INBOX_DIR, file), "utf8");
  // Key derived from the source bytes, not the payload: stable across runs and
  // across normalization changes, distinct per inbox file. This is what makes
  // every retry and every rerun safe against the AMS's persist-then-error behavior.
  const idemKey = createHash("sha256").update(`${file}\n${raw}`).digest("hex").slice(0, 32);
  const flags: Flag[] = [];
  const fail = (stage: Stage, reason: string, details?: unknown): Prepared => {
    console.log(`  NOT SUBMITTING — failed at ${stage}: ${reason}`);
    if (details !== undefined) console.log(`  ${JSON.stringify(details)}`);
    for (const f of flags) console.log(`  [flag] ${f.code}: ${f.detail}`);
    return {
      emailId,
      idemKey,
      payload: null,
      failure: { emailId, status: "failed", stage, reason, ...(details === undefined ? {} : { details }), flags },
      flags,
    };
  };

  console.log(`\n=== ${emailId} ===`);

  const ext = await extractEmail(raw, BASE_URL);
  if (!ext.ok) return fail("extract", ext.reason);
  await writeFile(path.join(ARTIFACTS_DIR, `extract-${emailId}.txt`), ext.output);

  const parsed = parseModelOutput(ext.output);
  if (!parsed.ok) return fail("parse", parsed.reason, { modelOutput: ext.output });

  const norm = normalizeRecord(parsed.value);
  flags.push(...norm.flags);
  if (!norm.candidate) {
    return fail("normalize", "extraction output could not be normalized to the AMS schema", { errors: norm.errors });
  }

  const grounded = groundRecord(norm.candidate, raw);
  flags.push(...grounded.flags);
  if (!grounded.payload) {
    return fail("ground", "extracted values are not supported by the source email", { errors: grounded.errors });
  }

  const p = grounded.payload;
  console.log(`  prepared: ${p.insuredName} / ${p.lineOfBusiness} / eff ${p.effectiveDate} / revenue ${p.annualRevenue ?? "null"}`);
  for (const f of flags) console.log(`  [flag] ${f.code}: ${f.detail}`);
  return { emailId, idemKey, payload: grounded.payload, failure: null, flags };
}

async function reconcile(outcomes: Outcome[]): Promise<Reconciliation | null> {
  const confirmedIds = new Set(
    outcomes.filter((o): o is Extract<Outcome, { status: "confirmed" }> => o.status === "confirmed").map((o) => o.recordId),
  );
  const stored = await listRecords(BASE_URL);
  if (stored === null) return null;

  const orphans: string[] = [];
  const storedIds = new Set<string>();
  const byIdentity = new Map<string, string[]>();
  for (const rec of stored) {
    const r = (typeof rec === "object" && rec !== null ? rec : {}) as Record<string, unknown>;
    const id = typeof r.recordId === "string" ? r.recordId : JSON.stringify(rec).slice(0, 40);
    storedIds.add(id);
    if (!confirmedIds.has(id)) orphans.push(id);
    const identity = identityKey(r.insuredName, r.lineOfBusiness, r.effectiveDate);
    byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), id]);
  }
  return {
    storedCount: stored.length,
    confirmedCount: confirmedIds.size,
    orphans,
    // Both directions matter: a confirmed record absent from the listing is
    // data loss even though every per-record GET succeeded earlier.
    missing: [...confirmedIds].filter((id) => !storedIds.has(id)),
    duplicateGroups: [...byIdentity.values()].filter((g) => g.length > 1),
  };
}

async function main(): Promise<number> {
  try {
    const health = await fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(3_000) });
    if (!health.ok) throw new Error(String(health.status));
  } catch {
    console.error(`Cannot reach the AMS stub at ${BASE_URL} — start it first: node stub/server.js`);
    return 1;
  }
  await mkdir(ARTIFACTS_DIR, { recursive: true });

  const files = (await readdir(INBOX_DIR)).filter((f) => f.endsWith(".txt")).sort();
  console.log(`Found ${files.length} emails in ${INBOX_DIR}/`);

  // Phase 1: extract → parse → normalize → ground (no writes yet)
  const prepared: Prepared[] = [];
  for (const file of files) prepared.push(await prepare(file));

  // Phase 2: cross-email collision check — two emails resolving to the same
  // logical record must not both be submitted blindly.
  const seenIdentity = new Map<string, string>();
  for (const p of prepared) {
    if (!p.payload) continue;
    const identity = logicalIdentity(p.payload);
    const prior = seenIdentity.get(identity);
    if (prior) {
      p.failure = { emailId: p.emailId, status: "skipped_duplicate", duplicateOf: prior, flags: p.flags };
      p.payload = null;
      console.log(`\n${p.emailId} resolves to the same logical record as ${prior} — skipping, needs human review`);
    } else {
      seenIdentity.set(identity, p.emailId);
    }
  }

  // Phase 3: submit sequentially — four emails against a rate-limiting API,
  // concurrency buys nothing and complicates 429 handling.
  const outcomes: Outcome[] = [];
  for (const p of prepared) {
    if (p.failure || !p.payload) {
      outcomes.push(
        p.failure ?? {
          emailId: p.emailId,
          status: "failed",
          stage: "normalize",
          reason: "internal: prepared without a payload or a failure — this is a pipeline bug",
          flags: p.flags,
        },
      );
      continue;
    }
    const payload = p.payload;
    console.log(`\n>>> submitting ${p.emailId} (idempotency key ${p.idemKey.slice(0, 12)}…)`);
    const result = await submitWithConfirm(payload, p.idemKey, p.emailId, BASE_URL);
    p.flags.push(...result.flags);
    outcomes.push(
      result.ok
        ? { emailId: p.emailId, status: "confirmed", recordId: result.recordId, payload, flags: p.flags }
        : {
            emailId: p.emailId,
            status: "failed",
            stage: result.stage,
            reason: result.reason,
            ...(result.details === undefined ? {} : { details: result.details }),
            flags: p.flags,
          },
    );
  }

  // Phase 4: reconcile — the AMS's list is the ground truth; our confirmed set
  // must match it exactly. Anything else is silent loss in one direction or the other.
  const recon = await reconcile(outcomes);

  printSummary(outcomes, recon);
  const reportPath = await writeRunReport(outcomes, recon);
  console.log(`\nFull machine-readable report: ${reportPath}`);

  const allConfirmed = outcomes.every((o) => o.status === "confirmed");
  const reconClean = recon !== null && reconciliationClean(recon);
  return allConfirmed && reconClean ? 0 : 1; // non-zero = a human needs to look at the summary
}

// process.exitCode (not process.exit) lets stdout drain — process.exit can
// truncate the summary when output is piped.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error("pipeline crashed:", err);
    process.exitCode = 1;
  },
);
