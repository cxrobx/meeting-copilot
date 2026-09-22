/**
 * The first complete top-level JSON object in a model response.
 *
 * gpt-6-luna under a strict json_schema still keeps writing after it has
 * closed a valid object: a stray `"}`, "(Remember output contract…)",
 * `</|end|>`, or a second copy of the whole object. It did that on 16 of 128
 * agenda reconciles replayed on 2026-09-22 (gpt-5.6-luna never did). Every
 * live-path parser sliced from the first `{` to the LAST `}`, which swallows
 * that tail, so JSON.parse threw and each lane lost a good answer silently —
 * triage turning it into `actionable: false`, the worst of them.
 *
 * Walk from the first `{`, string- and escape-aware, and stop where depth
 * returns to zero. The old first-to-last slice stays as the fallback so
 * nothing that parsed before stops parsing.
 *
 * The same replay caught a worse shape once: a first object that is not JSON
 * at all (`{"id":"id":"a6",…` — strict json_schema did not hold), then
 * garbled text and the model's own "JSON malformed … Should correct", then a
 * corrected object. So every complete top-level object is tried in order,
 * and a caller's `accept` check picks the first one shaped like its answer.
 */
function balancedObjectFrom(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Each complete top-level object, in order, as [text, parsed]. An object that
 * fails to parse is skipped whole — the scan resumes after it, never inside
 * it, so a fragment of a broken answer is not mistaken for an answer. A span
 * that never closes (truncated output) ends the scan.
 */
function* topLevelObjects(text: string): Generator<[string, Record<string, unknown>]> {
  let pos = text.indexOf('{');
  while (pos >= 0) {
    const span = balancedObjectFrom(text, pos);
    if (span === null) return;
    const parsed = tryParse(span);
    if (isObject(parsed)) yield [span, parsed];
    pos = text.indexOf('{', pos + span.length);
  }
}

function lastResortSlice(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

/**
 * The JSON text to parse: the first complete object that parses, else the
 * first-`{`-to-last-`}` slice, else the input unchanged (so a caller that
 * JSON.parses the result still throws on garbage, exactly as before).
 */
export function extractJsonText(text: string): string {
  for (const [span] of topLevelObjects(text)) return span;
  return lastResortSlice(text) ?? text;
}

/**
 * The first object that parses and that `accept` agrees is shaped like the
 * caller's answer, or null. Without `accept`, any object.
 */
export function parseFirstJsonObject<T = unknown>(
  text: string,
  accept?: (value: Record<string, unknown>) => boolean,
): T | null {
  if (!text) return null;
  for (const [, parsed] of topLevelObjects(text)) {
    if (!accept || accept(parsed)) return parsed as T;
  }
  const slice = lastResortSlice(text);
  const parsed = slice === null ? undefined : tryParse(slice);
  return isObject(parsed) && (!accept || accept(parsed)) ? (parsed as T) : null;
}
