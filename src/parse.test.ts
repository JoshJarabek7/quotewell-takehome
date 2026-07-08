import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModelOutput } from "./parse";

const proseAndFence = `Here is the extracted information from the email:

\`\`\`json
{
  "insuredName": "Blue Oak Industries LLC",
  "dba": "Blue Oak Manufacturing"
}
\`\`\`

Note that the revenue figure was corrected in the most recent message of the thread.`;

test("parseModelOutput: bare JSON", () => {
  const res = parseModelOutput('{"a": 1}');
  assert.deepEqual(res, { ok: true, value: { a: 1 } });
});

test("parseModelOutput: JSON inside prose and a markdown fence (real email_1 shape)", () => {
  const res = parseModelOutput(proseAndFence);
  assert.ok(res.ok);
  assert.equal((res.value as { insuredName: string }).insuredName, "Blue Oak Industries LLC");
});

test("parseModelOutput: braces inside string literals do not break the scan", () => {
  const res = parseModelOutput('note {"a": "b}c"} end');
  assert.deepEqual(res, { ok: true, value: { a: "b}c" } });
});

test("parseModelOutput: skips non-JSON brace groups in prose before the object", () => {
  const res = parseModelOutput('here it is {as requested}: {"a": 1} done');
  assert.deepEqual(res, { ok: true, value: { a: 1 } });
});

test("parseModelOutput: no JSON at all is a reported failure, not a crash", () => {
  const res = parseModelOutput("I wasn't able to confidently extract the requested fields from this document.");
  assert.equal(res.ok, false);
});

test("parseModelOutput: escaped quotes inside strings", () => {
  const res = parseModelOutput('x {"name": "say \\"hi\\" {ok}"} y');
  assert.deepEqual(res, { ok: true, value: { name: 'say "hi" {ok}' } });
});
