export type ParseResult = { ok: true; value: unknown } | { ok: false; reason: string };

export function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // JSON.parse can never legitimately produce undefined
  }
}

/**
 * Finds the next balanced {...} starting at or after `from`, ignoring braces
 * inside string literals. Returns the span and where it began so the caller
 * can resume scanning past a candidate that failed to parse.
 */
function balancedObjectFrom(text: string, from: number): { candidate: string; start: number } | null {
  const start = text.indexOf("{", from);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { candidate: text.slice(start, i + 1), start };
    }
  }
  return null;
}

/**
 * The extraction service returns raw model text: sometimes bare JSON, sometimes
 * JSON wrapped in prose and/or markdown fences, sometimes no JSON at all.
 * Prose can contain braces of its own ("{as requested}: {...}"), so the scan
 * keeps trying later candidates until one parses.
 */
export function parseModelOutput(raw: string): ParseResult {
  const trimmed = raw.trim();

  const direct = tryJson(trimmed);
  if (direct !== undefined) return { ok: true, value: direct };

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const fenceBody = fence?.[1]?.trim();
  if (fenceBody) {
    const fenced = tryJson(fenceBody);
    if (fenced !== undefined) return { ok: true, value: fenced };
  }

  let from = 0;
  for (;;) {
    const found = balancedObjectFrom(trimmed, from);
    if (found === null) break;
    const parsed = tryJson(found.candidate);
    if (parsed !== undefined) return { ok: true, value: parsed };
    from = found.start + 1;
  }

  return { ok: false, reason: "no parseable JSON object found in model output" };
}
