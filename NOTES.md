# NOTES

Decisions, cuts, and things I wouldn't ship as-is. Written as the work happened, not reconstructed.

## Recon findings that shaped the design

- **The README says three emails; `inbox/` has four.** email_4 (Tula Bakery) has no effective date — the broker explicitly defers it ("I'll get you the requested effective date once the owner confirms"). `effectiveDate` is required, and the extraction model fabricates `2026-07-01` for it anyway. I treated a clean, actionable failure report for this record as a *success* outcome, per the spec's own framing ("confirmed **or** clearly reported as failed"). The pipeline refuses to submit a required field the source doesn't support.
- The extraction model also hallucinated `annualRevenue: 850000` for email_2, whose source says revenue is TBD ("don't hold the submission for it"). The spec says don't guess revenue → grounding nulls it (field is nullable) and flags it.
- email_3's model output picked the facility address; the source explicitly says mail goes to the PO Box. See "judgment calls" below.

## Judgment calls (each is flagged in the run report when triggered)

- **Relative effective date (email_2):** "ideally first of next month" has no literal date; the email's `Date:` header (3 Jun 2026) anchors it to 2026-07-01, which is what the model extracted. I accept a date that resolves a relative phrase against the header date, with an `effective_date_inferred_from_relative_phrase` flag. If the model had returned nothing, the record would fail — the pipeline never synthesizes the value itself. I'm genuinely unsure where this line should sit; strict grounding would fail this record instead.
- **PO Box correction (email_3):** when the source contains an explicit PO Box mailing address and the extracted mailing street is not a PO Box, the pipeline corrects the mailing address from the source (strict parse: `PO Box N, City, ST 12345` — anything less parseable fails the record for human review instead). The assignment sanctions programmatic correction; still, this is the most aggressive thing the pipeline does, and it's flagged loudly.
- **Multiple revenue candidates (email_1):** thread contains both $4.2M (correction, newest) and $3.8M (quoted original). Grounding alone can't catch a stale pick — both appear in the source. Policy: in reply-quoted threads, earlier text position = newer content; a value matching the newest candidate is kept (flagged), a value matching only an older candidate is nulled and flagged for human review. Generic thread semantics, not a per-file hack.
- **Sequential processing, by choice.** Four emails against a rate-limiting API; concurrency buys nothing and complicates 429 handling.
- **State resolution is algorithmic, not fuzzy.** Written states resolve via exact USPS code → exact full name → *unique prefix* of exactly one state name ("Tex."→TX, "Calif."→CA falls out for free) → a 6-entry AP-style exception table for standardized forms that are ambiguous prefixes ("Miss." could open Mississippi or Missouri). I deliberately rejected edit-distance fuzzy matching: its failure mode is silently mapping a typo to a plausible-but-wrong state, which is the exact class of error this pipeline exists to prevent. Ambiguous input fails the record for human review instead.

## What I'd do with more time

- Retry constants (8 attempts, 10s per-attempt timeout, 120s per-record budget, 0.5–8s full-jitter backoff) are educated guesses; production would tune them against observed API behavior and add circuit breaking.
- The groundedness check is substring/representation-level. It would miss paraphrases and can't verify non-literal fields (insured name, street) — those pass through unverified. A production version would use a second model pass or fuzzy alignment.
- The money-literal scanner and date-representation generator cover the formats in evidence plus common variants; they are not exhaustive.
- **Mid-thread *date* corrections are a known gap.** Revenue gets newest-wins ranking across the thread; dates deliberately don't, because quoted email headers ("Sent: Monday, June 8, 2026") would make position-based ranking false-positive on almost every reply thread. If a thread corrected an effective date and the model extracted the stale one, grounding would pass it (both literals are present). Production fix: thread-aware date extraction that excludes header lines.
- A persistent local ledger (submitted keys → outcomes) would make crash recovery airtight across pipeline versions; today, idempotency keys derived from source bytes make reruns safe, which covers the realistic cases.

## Wouldn't ship as-is

- 422 responses fail the record with the API's details verbatim rather than attempting an automated fix-and-resubmit. Normalization runs *before* submission by design, so a 422 means my schema map has a gap; auto-fixing at that point risks a loop. Right call for this scope, but a production system would map `details` back onto normalizers.
- The line-of-business synonym map is curated, not comprehensive; the PO-Box mail-directive heuristic (a "mail…" word within ~120 chars before the PO Box) is calibrated against a small corpus.

## Second pass: review-driven hardening + unit tests

After the core build, I ran an adversarial self-review (via my AI tooling) against the README and fixed the latent issues it found before submitting — none changed the behavior on the four fixture emails, all were one-scenario-away bugs: reconciliation only checked one direction (a confirmed record *missing* from the AMS listing would have gone unnoticed — the worst possible silent loss); the PO-Box correction triggered on any PO Box in the email, including a broker's signature; an unparseable *optional* field ("annualRevenue": "TBD") failed the whole record instead of nulling per policy; the JSON scanner gave up on the first brace group in prose; date grounding couldn't verify some formats normalization accepted; confirmation-GET failures were reported as 404s that never happened. I also added 25 unit tests (`npm test` — node:test, no new dependencies) pinning the judgment-call policies in `ground.ts` and the pure coercions in `normalize.ts`/`parse.ts`.

## Dependencies

Runtime: `zod` only — schema validation of untrusted model output is exactly its job, and the 422-`details` failure shapes map cleanly onto its error reporting. Dev: `typescript`, `tsx`, `@types/node`. The assignment's own run example (`npx tsx pipeline.ts`) presupposes npm packages.

## Verification performed

- Fresh stub + `npm start`: email_1/2/3 CONFIRMED (each verified by a GET and a field-level compare against what was submitted), email_4 FAILED with an actionable reason; reconciliation exact (3 stored / 3 confirmed, no orphans, no duplicates). Along the way the run survived a 429, a 10s hang, several 503s, and repeated 200s with unusable bodies.
- Rerun without a stub restart: the same recordIds come back via the idempotency keys; still exactly 3 records.
- `SIGKILL` mid-run — at a point where 2 records had persisted but the run died before reporting them — then rerun: the rerun adopts the orphaned records via the same keys and ends with exactly 3. No duplicates.
- `npm run typecheck` clean; `npm test` 25/25; clean reinstall (`rm -rf node_modules && npm install && npm start`) verified; nothing under `stub/` modified.

## Constraints hit along the way

- The stub is CommonJS, so the project root cannot be `"type": "module"` — my initial ESM scaffold crashed it (the crash also dumped the stub's bundled source into my console; the pipeline design predates that and takes nothing from it — it was already fully specified in CLAUDE.md before any code existed).
- Project layout, tooling, and the agent brief (CLAUDE.md) were set up before writing any pipeline code. CLAUDE.md is included in the submission — updated as decisions were made — as part of the "how I work with AI tools" record.
