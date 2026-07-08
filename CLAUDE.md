# CLAUDE.md

Take-home for the QuoteWell Applied AI Engineering role. Read this whole file, then the root `README.md`, then `stub/README.md`, then every file in `inbox/`, before writing any code.

**The pipeline:** for each email in `inbox/`, POST the raw text to the local extraction service, turn the raw model output into a valid AMS record, submit it to a deliberately unreliable AMS API, confirm it actually persisted, and report the outcome.

**What's being graded:** whether the pipeline survives an unreliable API and ambiguous model output without losing data. Not framework choice, not test coverage, not polish. `NOTES.md` is half the signal. Hard cap of 3 hours, so every decision biases toward the smallest thing that is actually correct.

## Hard rules

- Never modify anything in `stub/`. Treat the stub as a **black box**: learn its behavior by making requests and observing, not by reading `server.js`. Reverse-engineering the deterministic failure schedule would let us overfit, and generic resilience is the whole point. If a response shape is genuinely ambiguous and blocking, ask Josh before opening the stub source.
- TypeScript, strict mode, Node 18+ native `fetch`. External libraries are permitted — the assignment's own run example is `npx tsx pipeline.ts`, which presupposes npm packages — but keep dependencies minimal and individually defensible in the Loom. Currently: `zod` at runtime (validating untrusted model output is exactly its job); `typescript`, `tsx`, `@types/node` as dev deps. Unit tests use node:test — no test framework.
- The stub is CommonJS and inherits the root `package.json`, so the root must stay `"type": "commonjs"` — an ESM root crashes it (learned the hard way). `tsx` runs our ESM-syntax TypeScript regardless.
- No hand-transcribed payloads. Every submitted value must flow from the extraction output through generic parsing and normalization. Synonym maps and format coercions are fine; `if (file === "email_2") payload.zip = "78701"` is disqualifying. One sanctioned exception, added after recon: the assignment itself says "detecting, **correcting**, or flagging its mistakes programmatically is part of the task," so a **generic** rule may correct a field from the raw source text when the source explicitly contradicts the extraction (see the PO Box rule in §1). The correction source is always the email itself — never invented data, never keyed to a specific file.
- Never submit fabricated data. If a required field is missing from the source email or looks hallucinated by the model, a clean, actionable failure report is the correct outcome. The spec says every record ends either **confirmed** or **clearly reported as failed**; both are wins. A successful submission of garbage is the only loss.

## The four traps, and the invariants that handle them

### 1. Extraction output is untrusted model text

- Parse defensively: strip markdown fences, hunt for the first JSON object inside surrounding prose, tolerate absent or malformed JSON. Unparseable output becomes a reported failure with the raw model text attached, not a crash.
- Validate against a `zod` schema mirroring the AMS field table exactly.
- Normalize before validating: written states → 2-letter USPS codes via **unique-prefix resolution** against the 50 state names plus a small AP-style exception table (never edit-distance fuzzy matching, which can silently pick the wrong state; ambiguity fails for human review); ZIP+4 → 5 digits; common date formats → `YYYY-MM-DD`; `lineOfBusiness` synonyms (GL / CGL / general liability → `general_liability`, work comp / WC → `workers_compensation`, business owner's policy → `bop`, etc.); revenue strings like `$2.5M` or `2,500,000` → number; trim and lowercase emails. Unusable values in *optional* fields (`dba`, `annualRevenue`) demote to `null` with a flag — only required fields may fail the record.
- **Groundedness check:** for extracted literals (revenue figures, zip, email address, dates), verify a normalized form actually appears in the source email text. The spec warns the model will "confidently state things the source email does not support," and says explicitly not to guess revenue. Ungrounded optional field (`annualRevenue`) → set `null` and flag. Ungrounded or missing **required** field → do not submit; fail with details. The heuristic can be substring-level after normalization; note its limits in `NOTES.md` rather than gold-plating it.
- **Refined grounding policies, settled with Josh after recon (all generic, all flagged when triggered):**
  - *Relative effective date:* a date with no literal match is still grounded if the source contains a relative phrase ("first of next month") that, anchored to the email's `Date:` header, resolves to exactly the extracted value → accept + `effective_date_inferred_from_relative_phrase` flag. No phrase, no anchor → required-field failure. The pipeline never synthesizes the date itself.
  - *Multiple revenue candidates:* in reply-quoted threads, earlier text position = newer content. Extracted value matching the newest money literal → keep + flag; matching only an older one → `null` + flag for human review; matching none → `null` + flag (hallucination).
  - *PO Box mailing address:* if the source contains an explicit PO Box address but the extracted mailing street is not a PO Box, strictly parse `PO Box N, City, ST 12345` from the source and correct the whole mailing address + loud flag. If it doesn't parse cleanly, fail the record for human review rather than submit an address the source explicitly warns against.

### 2. The AMS is not idempotent

- Send an `Idempotency-Key` header on **every** attempt, including the first. A request can persist and then time out, so a keyless first attempt is already unsafe.
- Derive the key deterministically from the source, e.g. `sha256(filename + raw email bytes)` truncated. Never random per attempt or per run.
- Before submitting anything, compare normalized payloads across all emails. If two emails resolve to the same logical record (same insured + line of business + effective date), do not blindly submit both. Surface the collision, decide explicitly, and record the reasoning. See Recon step 1.
- Practical note: the stub keeps state until restarted, and a repeated key returns the **original** record. During development, restart the stub between runs so stale records don't confuse debugging.

### 3. Transport is hostile: 429s, long hangs, 5xx

- Every request gets an `AbortController` timeout (extract ~15s, AMS ~10s per attempt). The spec says the API "hangs for a long time"; an unbounded await is data loss waiting to happen.
- Retry policy: `429` → wait `Retry-After` (with a sane floor and ceiling); timeout / `5xx` / network error → exponential backoff with full jitter, max ~6 attempts and a per-record time budget of ~90s; `422` → attempt one programmatic fix if `details` maps to a known normalization, otherwise fail with the details verbatim; `400` → no blind retry, fail with the response body.
- Where the retry loop lives, leave a comment stating that retries are only safe because of the idempotency key. This is a why-comment worth its bytes.

### 4. Success responses lie

- A `2xx` is a claim, not a fact ("a 200 does not necessarily mean what you think it means"). After any `2xx`: parse the body defensively, extract `recordId` if present, then `GET /api/v1/records/:id` and deep-compare the seven business fields against the submitted payload. Only a matching GET flips the record to **CONFIRMED**.
- `2xx` with a malformed or missing body → resubmit with the same idempotency key (safe), then confirm via GET.
- Stored record differs from submitted payload (e.g. a key collision returned someone else's original) → flag loudly, do not count as confirmed.
- End-of-run reconciliation: `GET /api/v1/records` and assert the stored set is exactly the confirmed set. No duplicates, no orphans. An orphan (stored but never confirmed by us) gets reported too; that's silent loss running in reverse.

## Shape of the code

Single entry point, small pure modules, no classes for their own sake:

```
src/
  pipeline.ts    orchestrator + final report; exit code 1 if anything failed
  extract.ts     POST /api/v1/extract (reliable per spec; one timeout, no retry ceremony)
  parse.ts       raw model text → unknown JSON candidate
  normalize.ts   field coercions + synonym maps (pure functions, the one unit-testable spot)
  schema.ts      zod schema + RecordPayload type
  ground.ts      groundedness checks against the source email
  submit.ts      idempotent submit with retry/timeout + confirm-by-GET
  report.ts      outcome types + console summary + artifacts/run-report.json
```

Merge adjacent modules if they end up trivially small; do not split further.

The per-email outcome is a discriminated union, roughly:

```ts
type Outcome =
  | { status: "confirmed"; recordId: string; flags: Flag[] }
  | { status: "failed"; stage: Stage; reason: string; details?: unknown; flags: Flag[] }
  | { status: "skipped_duplicate"; duplicateOf: string; flags: Flag[] };
```

`flags` carry every judgment call the pipeline made (nulled an ungrounded revenue, assumed MM/DD date convention, applied a synonym mapping, detected a cross-email collision). The final report and `NOTES.md` should nearly write themselves from the flags.

Persist run artifacts to `artifacts/`: the raw model output per email and the final report JSON. These are the show-and-tell material for the Loom.

Logging: one structured console line per attempt (email, attempt #, status, wait). Human-readable summary table at the end. No logging framework.

Process emails sequentially. Four emails against a rate-limiting API; concurrency buys nothing and complicates the 429 handling. One `NOTES.md` line explains this was deliberate.

## Process

1. **Recon first, ~20 minutes, no code.** Read the root README, `stub/README.md`, and all inbox emails. Note: the README says "three messy insurance emails" but `inbox/` contains **four** files. **Resolved during recon:** email_4 (Tula Bakery) has no effective date — the broker explicitly defers it — and the extractor fabricates `2026-07-01` anyway. It is the planted "a clean failure is a success condition" case; the pipeline must fail it with an actionable report, never submit it. Recon also showed the extractor hallucinating email_2's revenue (source says TBD) and picking email_3's facility address over the mandated PO Box — see the refined grounding policies in §1. Then start the stub, curl both endpoints, and save each email's raw extraction output into `artifacts/` so we know exactly what the parser is up against.
2. **Vertical slice:** one email end to end with minimal hardening. Confirm it lands and the GET matches.
3. **Harden** per the four invariants. Run all emails. Make the failure and flag reporting genuinely good; that output is the product.
4. **Reconciliation + report polish.** Verify the kill-and-rerun case: interrupt a run midway, rerun, confirm no duplicates.
5. **Docs pass** (below).

Timebox any rabbit hole to 15 minutes. When hit, take the simpler path and add a `NOTES.md` line. Update `NOTES.md` as decisions happen, not reconstructed at the end.

## Docs to produce

- **`NOTES.md`** (submitted, half the grade): what got cut, what more time would buy, what isn't ship-ready. Be specific: retry constants are educated guesses, the groundedness check is substring-level and would miss paraphrase, sequential by choice, the fourth-email decision and its reasoning. Honest and short beats comprehensive.
- **README section** (submitted): five lines. `npm start`, prerequisite that the stub is running, where the report lands.
- **`WALKTHROUGH.md`** (for Josh's prep, generated last, **excluded from the submitted zip**): a file-by-file tour in reading order with the why behind each invariant, plus two Loom candidates with specific file and line references: one **confident** decision (suggested: the idempotency-key derivation plus confirm-by-GET, treated as a single unit of "never trust, always verify") and one **unsure** decision (suggested: the email_2 inferred relative date, or the PO Box correction — where grounding should bend, and where correcting beats failing).

Do not generate any other documentation. A 3-hour take-home with ten markdown files reads as padding.

## Definition of done

- `npm start` from a clean copy (stub already running) processes every inbox email and prints a summary where each record is CONFIRMED with a `recordId`, or FAILED/SKIPPED with enough detail to act on.
- Restarting the stub and rerunning produces the same outcomes and no duplicate records (verified via `GET /api/v1/records`).
- Killing the run midway and rerunning does not create duplicates.
- Nothing under `stub/` was touched. No runtime deps beyond `zod`. `npm run typecheck` is clean.
- `NOTES.md` reflects real decisions, not aspirations.