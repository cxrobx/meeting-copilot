import { describe, expect, it } from 'vitest';
import { extractJsonText, parseFirstJsonObject } from '../intelligence/first-json.js';
import { parseAgendaResponse } from '../intelligence/agenda.js';

// The four tails gpt-6-luna wrote after a valid object in the 2026-09-22
// agenda replay (16 of 128 reconciles). Content is synthetic; the shapes are
// verbatim.
const OBJECT = '{"items":[{"id":"a1","state":"covered","evidence":"we met at the offsite"},{"id":"a2","state":"pending","evidence":""}],"missing_warnings":[]}';
const LEAKED_TAILS = [
  `${OBJECT}"} \n(Remember output contract use agenda_status object no extra? response format requires items state evidence and missing_warnings; exactly)\n<br>\n{"items":[`,
  `${OBJECT}"} (Should just output)\n</|end|>{"items":[{"id":"a1","state":"partial","evidence":"we met`,
  `${OBJECT}${OBJECT}`,
  `${OBJECT}\n${OBJECT.replace('covered', 'partial')}`,
];

describe('first complete JSON object', () => {
  it.each(LEAKED_TAILS)('takes the first object and ignores what the model wrote after it (%#)', (raw) => {
    expect(parseFirstJsonObject(raw)).toEqual(JSON.parse(OBJECT));
  });

  it('parses an agenda reconcile that leaked a second copy', () => {
    const parsed = parseAgendaResponse(LEAKED_TAILS[3]!);
    expect(parsed?.items.map((i) => i.state)).toEqual(['covered', 'pending']);
  });

  it('skips a malformed first object and takes the corrected one after the chatter', () => {
    // Seen once in the replay: strict json_schema did not hold, the model
    // noticed ("JSON malformed … Should correct"), and wrote it again.
    const broken = '{"items":[{"id":"id":"a1","state":"covered","evidence":"x"}],"missing_warnings":[]}';
    const raw = `${broken} \n السystem еиҭ \n JSON malformed id duplicate? Should correct. a1 asked, answered, covered.\n${OBJECT}`;
    expect(parseAgendaResponse(raw)?.items.map((i) => i.state)).toEqual(['covered', 'pending']);
  });

  it('lets the caller reject an object that is the wrong shape', () => {
    const raw = '{"note":"thinking"} {"actionable":true,"reason":"r","triggerQuote":"q"}';
    expect(parseFirstJsonObject(raw, (o) => typeof o.actionable === 'boolean')).toEqual({
      actionable: true, reason: 'r', triggerQuote: 'q',
    });
  });

  it('never returns a fragment from inside a truncated object', () => {
    // The outer object never closes; its inner item objects must not be
    // mistaken for an answer.
    const raw = '{"items":[{"id":"a1","state":"covered","evidence":"x"},{"id":"a2","sta';
    expect(parseFirstJsonObject(raw)).toBeNull();
  });

  it('is not fooled by braces and escaped quotes inside strings', () => {
    const raw = '{"a":"a } brace and a \\"quoted {x}\\" word","b":{"c":1}} trailing }';
    expect(parseFirstJsonObject(raw)).toEqual({ a: 'a } brace and a "quoted {x}" word', b: { c: 1 } });
  });

  it('still reads an object wrapped in prose or fences', () => {
    expect(parseFirstJsonObject('Here you go:\n```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('falls back to the old first-to-last slice when the first balanced span does not parse', () => {
    // A stray `{` in leading prose used to be skipped by the last-`}` slice
    // only when the whole span parsed; keep that exact behaviour.
    expect(extractJsonText('no json here')).toBe('no json here');
    expect(parseFirstJsonObject('{"truncated": "never closed')).toBeNull();
  });

  it('returns null rather than a primitive', () => {
    expect(parseFirstJsonObject('"just a string"')).toBeNull();
    expect(parseFirstJsonObject('')).toBeNull();
  });
});
