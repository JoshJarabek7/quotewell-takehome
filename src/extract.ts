export type ExtractResult = { ok: true; output: string } | { ok: false; reason: string };

/** The extraction service is reliable per spec: one timeout, no retry ceremony. */
export async function extractEmail(rawEmail: string, baseUrl: string): Promise<ExtractResult> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: rawEmail }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, reason: `extraction service returned ${res.status}` };
    const body = (await res.json()) as { output?: unknown };
    if (typeof body?.output !== "string") {
      return { ok: false, reason: "extraction response has no string 'output' field" };
    }
    return { ok: true, output: body.output };
  } catch (err) {
    return { ok: false, reason: `extraction request failed: ${(err as Error).message}` };
  }
}
