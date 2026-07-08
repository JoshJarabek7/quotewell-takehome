import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDate, normalizeLob, normalizeRecord, normalizeState, parseMoney } from "./normalize";

test("normalizeState: codes, dotted codes, full names, prefixes, AP exceptions", () => {
  assert.deepEqual(normalizeState("TX"), { code: "TX", mapped: false });
  assert.deepEqual(normalizeState("tx"), { code: "TX", mapped: true });
  assert.deepEqual(normalizeState("N.Y."), { code: "NY", mapped: true });
  assert.deepEqual(normalizeState("California"), { code: "CA", mapped: true });
  assert.deepEqual(normalizeState("New Mexico"), { code: "NM", mapped: true });
  // unique-prefix resolution — no hard-coded abbreviation list needed
  assert.deepEqual(normalizeState("Tex."), { code: "TX", mapped: true });
  assert.deepEqual(normalizeState("Calif."), { code: "CA", mapped: true });
  assert.deepEqual(normalizeState("Ore."), { code: "OR", mapped: true });
  assert.deepEqual(normalizeState("Mont."), { code: "MT", mapped: true });
  // AP-style forms that are ambiguous prefixes come from the exception table
  assert.deepEqual(normalizeState("Miss."), { code: "MS", mapped: true });
  assert.deepEqual(normalizeState("Ala."), { code: "AL", mapped: true });
  assert.deepEqual(normalizeState("W.Va."), { code: "WV", mapped: true });
  // ambiguous or unknown → null, never a guess
  assert.equal(normalizeState("New"), null); // NH/NJ/NM/NY all match
  assert.equal(normalizeState("ZZ"), null);
  assert.equal(normalizeState(""), null);
});

test("normalizeDate: formats, flags, and invalid dates", () => {
  assert.deepEqual(normalizeDate("2026-07-01"), { iso: "2026-07-01", flags: [] });
  // LLMs habitually emit ISO datetimes for date fields
  assert.equal(normalizeDate("2026-07-01T00:00:00Z")?.iso, "2026-07-01");
  assert.equal(normalizeDate("2026-07-01T00:00:00.000Z")?.iso, "2026-07-01");

  const mdy = normalizeDate("07/01/2026");
  assert.equal(mdy?.iso, "2026-07-01");
  assert.deepEqual(mdy?.flags.map((f) => f.code), ["date_assumed_month_first"]);

  const dashed = normalizeDate("07-01-2026");
  assert.equal(dashed?.iso, "2026-07-01");

  const shortYear = normalizeDate("8/15/26");
  assert.equal(shortYear?.iso, "2026-08-15");
  assert.deepEqual(shortYear?.flags.map((f) => f.code), ["two_digit_year_expanded"]);

  const dayFirst = normalizeDate("15/8/2026");
  assert.equal(dayFirst?.iso, "2026-08-15");
  assert.deepEqual(dayFirst?.flags.map((f) => f.code), ["date_interpreted_day_first"]);

  // same month/day → no ambiguity to flag
  assert.deepEqual(normalizeDate("6/6/2026"), { iso: "2026-06-06", flags: [] });

  assert.equal(normalizeDate("July 1, 2026")?.iso, "2026-07-01");
  assert.equal(normalizeDate("Sept 3rd, 2026")?.iso, "2026-09-03");

  assert.equal(normalizeDate("2026-02-30"), null); // not a real date
  assert.equal(normalizeDate("13/13/2026"), null);
  assert.equal(normalizeDate("soon"), null);
});

test("normalizeLob: canonical, synonyms, possessives", () => {
  assert.deepEqual(normalizeLob("workers_compensation"), { lob: "workers_compensation", mapped: false });
  assert.deepEqual(normalizeLob("general liability"), { lob: "general_liability", mapped: true });
  assert.deepEqual(normalizeLob("GL"), { lob: "general_liability", mapped: true });
  assert.deepEqual(normalizeLob("work comp"), { lob: "workers_compensation", mapped: true });
  assert.deepEqual(normalizeLob("Business Owner's Policy"), { lob: "bop", mapped: true });
  assert.deepEqual(normalizeLob("Workers' Comp"), { lob: "workers_compensation", mapped: true });
  assert.equal(normalizeLob("umbrella"), null);
});

test("parseMoney: scales, grouping, unparseable", () => {
  assert.equal(parseMoney("$4.2M"), 4_200_000);
  assert.equal(parseMoney("950k"), 950_000);
  assert.equal(parseMoney("2,500,000"), 2_500_000);
  assert.equal(parseMoney("1.2 million"), 1_200_000);
  assert.equal(parseMoney("$1,234.56"), 1235);
  assert.equal(parseMoney("4mm"), 4_000_000); // "mm" must win over "m" in the alternation
  assert.equal(parseMoney("TBD"), null);
  assert.equal(parseMoney(""), null);
});

// The exact shape the extraction service returns for email_1 (prose stripped).
const email1Extraction = {
  insuredName: "Blue Oak Industries LLC",
  dba: "Blue Oak Manufacturing",
  mailingAddress: { street: "4180 Commerce Park Dr, Suite B", city: "Waco", state: "Tex.", zip: "76712" },
  lineOfBusiness: "general liability",
  effectiveDate: "07/01/2026",
  annualRevenue: "$4.2M",
  contactEmail: "maria@blueoakmfg.com",
};

test("normalizeRecord: real email_1 extraction normalizes with the exact flag set", () => {
  const res = normalizeRecord(email1Extraction);
  assert.ok(res.candidate, JSON.stringify(res.errors));
  assert.equal(res.candidate.mailingAddress.state, "TX");
  assert.equal(res.candidate.lineOfBusiness, "general_liability");
  assert.equal(res.candidate.effectiveDate, "2026-07-01");
  assert.equal(res.candidate.annualRevenue, 4_200_000);
  assert.deepEqual(
    new Set(res.flags.map((f) => f.code)),
    new Set(["state_normalized", "lob_synonym_mapped", "date_assumed_month_first", "date_normalized", "revenue_parsed_from_string"]),
  );
});

test("normalizeRecord: unusable optional fields demote to null instead of failing the record", () => {
  const res = normalizeRecord({ ...email1Extraction, annualRevenue: "TBD", dba: "" });
  assert.ok(res.candidate, JSON.stringify(res.errors)); // record survives
  assert.equal(res.candidate.annualRevenue, null);
  assert.equal(res.candidate.dba, null);
  assert.ok(res.flags.some((f) => f.code === "revenue_unparseable_nulled"));
});

test("normalizeRecord: missing required fields fail with actionable errors", () => {
  const res = normalizeRecord({ ...email1Extraction, effectiveDate: undefined, contactEmail: "not-an-email" });
  assert.equal(res.candidate, null);
  assert.ok(res.errors.some((e) => e.startsWith("effectiveDate")));
  assert.ok(res.errors.some((e) => e.startsWith("contactEmail")));
});

test("normalizeRecord: non-object input fails cleanly", () => {
  assert.equal(normalizeRecord("just some prose").candidate, null);
  assert.equal(normalizeRecord(null).candidate, null);
  assert.equal(normalizeRecord([1, 2]).candidate, null);
});
