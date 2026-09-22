import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { PRESENT_HTML } from '../present/index.js';

// The dashboard is JavaScript inside a TypeScript template literal, so an
// escape written for JS (`'\n'`) is decoded by TS first and ships as a raw
// newline inside a JS string. tsc and every other test pass; the page is
// blank. That happened on 2026-09-22 with `join('\n')`. This parses the
// script the browser will actually receive.
describe('/present dashboard script', () => {
  const inline = [...PRESENT_HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);

  it('has inline scripts to check', () => {
    expect(inline.length).toBeGreaterThanOrEqual(2);
  });

  it.each(inline.map((code, i) => [i, code] as const))('inline script %i parses', (_i, code) => {
    expect(() => new Script(code)).not.toThrow();
  });
});
