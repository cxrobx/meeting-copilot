/**
 * Tolerant, incremental parser for a single streaming suggestion JSON object.
 *
 * The realtime Sonnet suggestion is emitted as one JSON object, token by token.
 * To render the card as it forms — and to launch the worker the moment its
 * `params` are complete (pre-approval) — we need to read whichever top-level
 * fields have arrived so far, including a *partial* string for the field still
 * being written.
 *
 * Why a depth-1 scanner instead of regex: `params` itself contains keys like
 * "description"/"context", so a naive /"description"\s*:/ match would pick up
 * the nested one. We walk the root object and only read keys at depth 1.
 */

export interface PartialSuggestion {
  type?: string;
  title?: string;
  description?: string;
  triggerQuote?: string;
  estimatedDurationSec?: number;
  params?: Record<string, any>;
  /** True once the `params` object has fully closed — safe to dispatch a worker. */
  paramsReady: boolean;
  /** True once the whole root object has closed (valid complete JSON). */
  done: boolean;
}

interface ReadResult {
  value: any;
  complete: boolean;
  end: number; // index just past the consumed token
}

/** Read a JSON string starting at the opening quote `buf[start] === '"'`. */
function readString(buf: string, start: number): ReadResult {
  let escaped = false;
  for (let i = start + 1; i < buf.length; i++) {
    const c = buf[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') {
      const raw = buf.slice(start, i + 1);
      let value: string;
      try { value = JSON.parse(raw); } catch { value = buf.slice(start + 1, i); }
      return { value, complete: true, end: i + 1 };
    }
  }
  // No closing quote yet → partial string. Decode what we have.
  let raw = buf.slice(start + 1);
  if (escaped) raw = raw.slice(0, -1); // drop a dangling backslash
  let value: string;
  try { value = JSON.parse('"' + raw + '"'); } catch { value = raw; }
  return { value, complete: false, end: buf.length };
}

/** Read a `{...}` or `[...]` container starting at `buf[start]`. */
function readContainer(buf: string, start: number): ReadResult {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < buf.length; i++) {
    const c = buf[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        const span = buf.slice(start, i + 1);
        try { return { value: JSON.parse(span), complete: true, end: i + 1 }; }
        catch { return { value: undefined, complete: false, end: i + 1 }; }
      }
    }
  }
  return { value: undefined, complete: false, end: buf.length };
}

/** Read a primitive (number/true/false/null) until a delimiter. */
function readPrimitive(buf: string, start: number): ReadResult {
  let i = start;
  while (i < buf.length && !/[,}\]\s]/.test(buf[i]!)) i++;
  const token = buf.slice(start, i);
  // Complete only if a delimiter/whitespace follows — a token running to the
  // end of the buffer might still be growing.
  const complete = i < buf.length;
  let value: any = token;
  if (token === 'true') value = true;
  else if (token === 'false') value = false;
  else if (token === 'null') value = null;
  else if (/^-?\d+(?:\.\d+)?$/.test(token)) value = Number(token);
  return { value, complete, end: i };
}

/**
 * Scan the root object and return each depth-1 field's value + completeness.
 * A string still being written comes back partial. Stops at the root's
 * closing brace, so text a model writes after the object is never read.
 */
export function scanTopLevel(buf: string): Map<string, { value: any; complete: boolean }> {
  const fields = new Map<string, { value: any; complete: boolean }>();
  let i = 0;
  while (i < buf.length && buf[i] !== '{') i++;
  if (i >= buf.length) return fields;
  i++; // past root '{'

  while (i < buf.length) {
    while (i < buf.length && /[\s,]/.test(buf[i]!)) i++; // skip ws + commas
    if (i >= buf.length || buf[i] === '}') break;
    if (buf[i] !== '"') break; // malformed or key not started

    const keyRes = readString(buf, i);
    if (!keyRes.complete) break; // key still streaming
    const key = keyRes.value as string;
    i = keyRes.end;

    while (i < buf.length && /\s/.test(buf[i]!)) i++;
    if (i >= buf.length || buf[i] !== ':') { fields.set(key, { value: undefined, complete: false }); break; }
    i++; // past ':'
    while (i < buf.length && /\s/.test(buf[i]!)) i++;
    if (i >= buf.length) { fields.set(key, { value: undefined, complete: false }); break; }

    const c = buf[i]!;
    let res: ReadResult;
    if (c === '"') res = readString(buf, i);
    else if (c === '{' || c === '[') res = readContainer(buf, i);
    else res = readPrimitive(buf, i);

    fields.set(key, { value: res.complete ? res.value : (c === '"' ? res.value : undefined), complete: res.complete });
    if (!res.complete) break;
    i = res.end;
  }
  return fields;
}

export function parsePartialSuggestion(buf: string): PartialSuggestion {
  const fields = scanTopLevel(buf);
  let done = false;
  try { JSON.parse(buf); done = true; } catch { /* not closed */ }

  const res: PartialSuggestion = { paramsReady: false, done };
  const str = (k: string): string | undefined => {
    const f = fields.get(k);
    return f && typeof f.value === 'string' ? f.value : undefined;
  };

  res.type = str('type');
  res.title = str('title');
  res.description = str('description');
  res.triggerQuote = str('triggerQuote');

  const ed = fields.get('estimatedDurationSec');
  if (ed && ed.complete && typeof ed.value === 'number') res.estimatedDurationSec = ed.value;

  const p = fields.get('params');
  if (p && p.complete && p.value && typeof p.value === 'object') {
    res.params = p.value;
    res.paramsReady = true;
  }
  return res;
}
