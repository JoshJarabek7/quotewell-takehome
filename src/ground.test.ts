import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dateRepresentations, groundRecord } from "./ground";
import { normalizeDate, type Candidate } from "./normalize";

const email1 = readFileSync("inbox/email_1.txt", "utf8");
const email2 = readFileSync("inbox/email_2.txt", "utf8");
const email3 = readFileSync("inbox/email_3.txt", "utf8");
const email4 = readFileSync("inbox/email_4.txt", "utf8");

const blueOak: Candidate = {
  insuredName: "Blue Oak Industries LLC",
  dba: "Blue Oak Manufacturing",
  mailingAddress: { street: "4180 Commerce Park Dr, Suite B", city: "Waco", state: "TX", zip: "76712" },
  lineOfBusiness: "general_liability",
  effectiveDate: "2026-07-01",
  annualRevenue: 4_200_000,
  contactEmail: "maria@blueoakmfg.com",
};

const pelican: Candidate = {
  insuredName: "Pelican Point Seafood House Inc",
  dba: null,
  mailingAddress: { street: "2217 Shoreline Blvd", city: "Mobile", state: "AL", zip: "36605" },
  lineOfBusiness: "workers_compensation",
  effectiveDate: "2026-07-01",
  annualRevenue: null,
  contactEmail: "curtis@pelicanpointseafood.com",
};

const sundance: Candidate = {
  insuredName: "High Desert Holdings LLC",
  dba: "Sundance Storage",
  mailingAddress: { street: "880 Frontage Rd", city: "Bend", state: "OR", zip: "97701" },
  lineOfBusiness: "commercial_property",
  effectiveDate: "2026-08-15",
  annualRevenue: 950_000,
  contactEmail: "gary.hudd@sundancestorage.com",
};

const tula: Candidate = {
  insuredName: "Tula Bakery LLC",
  dba: "Tula's",
  mailingAddress: { street: "614 Larkin St", city: "San Francisco", state: "CA", zip: "94109" },
  lineOfBusiness: "bop",
  effectiveDate: "2026-07-01", // fabricated by the extractor — nothing in the source supports it
  annualRevenue: 1_200_000,
  contactEmail: "sofia@tulabakery.com",
};

test("relative date: 'first of next month' anchored to the Date header is accepted with a flag", () => {
  const res = groundRecord(pelican, email2);
  assert.ok(res.payload, JSON.stringify(res.errors));
  assert.ok(res.flags.some((f) => f.code === "effective_date_inferred_from_relative_phrase"));
});

test("relative date: a date that contradicts the resolved phrase is rejected", () => {
  const res = groundRecord({ ...pelican, effectiveDate: "2026-08-01" }, email2);
  assert.equal(res.payload, null);
  assert.ok(res.errors.some((e) => /resolves to 2026-07-01 instead/.test(e)));
});

test("fabricated date (email_4): refused with an actionable error, everything else grounded", () => {
  const res = groundRecord(tula, email4);
  assert.equal(res.payload, null);
  assert.equal(res.errors.length, 1, JSON.stringify(res.errors)); // only the date is unsupported
  assert.ok(/invented|does not appear/.test(res.errors[0] as string));
});

test("revenue: matching the newest of several amounts is kept, with a flag", () => {
  const res = groundRecord(blueOak, email1);
  assert.ok(res.payload, JSON.stringify(res.errors));
  assert.equal(res.payload.annualRevenue, 4_200_000);
  assert.ok(res.flags.some((f) => f.code === "revenue_multiple_candidates_kept_newest"));
});

test("revenue: matching only an older (stale) amount is nulled for human review", () => {
  const res = groundRecord({ ...blueOak, annualRevenue: 3_800_000 }, email1);
  assert.ok(res.payload, JSON.stringify(res.errors));
  assert.equal(res.payload.annualRevenue, null);
  assert.ok(res.flags.some((f) => f.code === "revenue_stale_candidate_nulled"));
});

test("revenue: an amount with no support in the source is nulled (hallucination)", () => {
  const res = groundRecord({ ...pelican, annualRevenue: 850_000 }, email2);
  assert.ok(res.payload, JSON.stringify(res.errors));
  assert.equal(res.payload.annualRevenue, null);
  assert.ok(res.flags.some((f) => f.code === "revenue_ungrounded_nulled"));
});

test("PO Box: explicit mail directive corrects the extracted facility address (email_3)", () => {
  const res = groundRecord(sundance, email3);
  assert.ok(res.payload, JSON.stringify(res.errors));
  assert.deepEqual(res.payload.mailingAddress, { street: "PO Box 1142", city: "Bend", state: "OR", zip: "97709" });
  assert.ok(res.flags.some((f) => f.code === "mailing_address_corrected_to_po_box"));
});

test("PO Box: directive present but address unparseable → fail for human review, not a guess", () => {
  const source = [
    "Date: Mon, 1 Jun 2026 10:00:00 -0500",
    "From: someone@agency.com",
    "please mail everything to our PO Box 55, thanks",
    "insured is at zip 36605, contact bob@example.com, effective 07/01/2026",
  ].join("\n");
  const candidate: Candidate = {
    ...pelican,
    mailingAddress: { street: "123 Main St", city: "Mobile", state: "AL", zip: "36605" },
    contactEmail: "bob@example.com",
  };
  const res = groundRecord(candidate, source);
  assert.equal(res.payload, null);
  assert.ok(res.errors.some((e) => /needs human review/.test(e)));
});

test("PO Box: one merely appearing in a signature does NOT rewrite the insured's address", () => {
  const source = [
    "Date: Mon, 1 Jun 2026 10:00:00 -0500",
    "New submission. Insured: Foo Inc, 123 Main St, Mobile, AL 36605.",
    "contact bob@example.com, effective 07/01/2026",
    "--",
    "Harbor Light Risk Advisors",
    "PO Box 900, Mobile, AL 36601",
  ].join("\n");
  const candidate: Candidate = {
    ...pelican,
    insuredName: "Foo Inc",
    mailingAddress: { street: "123 Main St", city: "Mobile", state: "AL", zip: "36605" },
    contactEmail: "bob@example.com",
  };
  const res = groundRecord(candidate, source);
  assert.ok(res.payload, JSON.stringify(res.errors));
  assert.equal(res.payload.mailingAddress.street, "123 Main St");
  assert.ok(!res.flags.some((f) => f.code === "mailing_address_corrected_to_po_box"));
});

test("ungrounded contact email is refused", () => {
  const res = groundRecord({ ...pelican, contactEmail: "someone.else@gmail.com" }, email2);
  assert.equal(res.payload, null);
  assert.ok(res.errors.some((e) => e.startsWith("contactEmail")));
});

test("consistency invariant: every date form normalize accepts, ground can verify", () => {
  const forms = ["07/01/2026", "8/15/26", "15/8/2026", "07-01-2026", "July 1, 2026", "Aug. 15, 2026", "August 15th, 2026"];
  for (const form of forms) {
    const norm = normalizeDate(form);
    assert.ok(norm, `normalizeDate rejected ${form}`);
    const reps = dateRepresentations(norm.iso).map((r) => r.toLowerCase());
    assert.ok(reps.includes(form.toLowerCase()), `dateRepresentations(${norm.iso}) cannot verify source form "${form}"`);
  }
});
