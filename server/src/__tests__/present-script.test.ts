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

  // The main script is one IIFE of ~300 top-level names, and `var` lets a
  // second declaration silently replace the first. On 2026-09-22 the coach's
  // ASK_LABELS was overwritten by highlight-to-ask's, which ran later, so the
  // coach head threw on its first render. The IIFE body sits at two spaces.
  it.each(inline.map((code, i) => [i, code] as const))('inline script %i declares each top-level name once', (_i, code) => {
    const seen = new Map<string, number>();
    for (const m of code.matchAll(/^  (?:var|let|const|function) ([A-Za-z_$][\w$]*)/gm)) {
      seen.set(m[1]!, (seen.get(m[1]!) ?? 0) + 1);
    }
    expect([...seen].filter(([, n]) => n > 1).map(([name]) => name)).toEqual([]);
  });
  // Gotcha #27. The All tabs menu, drawn inside the sticky tab bar in the
  // scrolling main column, hit-tested as open (clicks reached it) but never
  // painted, so the button seemed dead (2026-09-24). A popover in that bar
  // goes on <body>, fixed, placed from its button's rect.
  it('draws the evidence tabs menu on <body>, fixed, not inside the sticky bar', () => {
    expect(PRESENT_HTML).toMatch(/\.ev-menu \{[^}]*position: fixed;/);
    const open = /function evOpenMenu\(\) \{([\s\S]*?)\n  \}\n/.exec(PRESENT_HTML)?.[1] ?? '';
    expect(open).toContain('document.body.appendChild(evMenuEl)');
    expect(open).not.toMatch(/getElementById\('evTabBar'\)[\s\S]*appendChild/);
  });
});
