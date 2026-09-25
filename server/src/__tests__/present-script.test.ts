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
  // The meeting chat (chat/service.ts): a fixed drawer (not a popover inside
  // a scroller, gotcha #27), opened from the header, the menu bar and ⌘J,
  // and fed from every place the page can select or attach.
  it('wires the chat drawer to the header, the menu bar, the socket and the attach points', () => {
    expect(PRESENT_HTML).toMatch(/\.chat-drawer \{[^}]*position: fixed;/);
    expect(PRESENT_HTML).toContain('<aside class="chat-drawer" id="chatDrawer"');
    expect(PRESENT_HTML).toContain('id="chatBtn" type="button" data-chat-act="toggle"');
    expect(PRESENT_HTML).toMatch(/window\.__copilotMenubar = function\(cmd, arg\) \{\s+if \(cmd === 'chat'\) \{\s+chatOpen\(true\);/);
    expect(PRESENT_HTML).toMatch(/case 'chat\.message':\s+case 'chat\.delta':\s+chatOnSocket\(msg\);/);
    // Attach points: selection toolbar, both right-click menus, the ask panel,
    // an evidence tab, the pulse.
    expect(PRESENT_HTML).toContain("mkBtn('Add to chat', '+'");
    expect(PRESENT_HTML).toContain('chatAttachSelection(askSel); });\n    askMenuEl.appendChild(askToChat);');
    expect(PRESENT_HTML).toContain('chatAttachCard(cardSel); });\n    cardMenuEl.appendChild(cardToChat);');
    expect(PRESENT_HTML).toContain('askpanel-chat');
    expect(PRESENT_HTML).toContain("else if (act === 'chat') chatAttach({ kind: 'tab'");
    expect(PRESENT_HTML).toContain('data-chat-act="pulse"');
    // An html evidence frame asks for the selection bridge, and only its own
    // frame's messages are believed.
    expect(PRESENT_HTML).toContain("frameSrc += (frameSrc.indexOf('?') < 0 ? '?' : '&') + 'frame=1'");
    expect(PRESENT_HTML).toContain('e.source !== frame.contentWindow');
  });

  // The page that asked gets every delta twice (POST + socket), in no
  // guaranteed relative order. Runs the shipped function itself.
  it('applies each chat delta once, in order, whichever channel brings it first', () => {
    const src = /\n  (function chatApplyDelta\(d\) \{[\s\S]*?\n  \})\n/.exec(PRESENT_HTML)?.[1] ?? '';
    expect(src).not.toBe('');
    const run = (m: Record<string, unknown>, deltas: Array<[number, string]>) => {
      const chatById = { a: m };
      const apply = new Function('chatById', 'chatQueueRender', `${src}; return chatApplyDelta;`)(chatById, () => {});
      for (const [seq, text] of deltas) apply({ id: 'a', seq, text });
      return m.content;
    };
    const fresh = () => ({ id: 'a', state: 'streaming', content: '', _seq: 0 });
    // Both channels, one reordered: 1 2 3 4 over the POST, 2 1 4 3 over the socket.
    expect(run(fresh(), [[2, 'b'], [1, 'a'], [1, 'a'], [2, 'b'], [4, 'd'], [3, 'c'], [3, 'c'], [4, 'd']])).toBe('abcd');
    // Loaded mid-answer (no _seq): the first delta it sees is its start.
    expect(run({ id: 'a', state: 'streaming', content: '' }, [[7, 'g'], [8, 'h'], [7, 'g']])).toBe('gh');
    // A finished answer takes no more deltas.
    expect(run({ id: 'a', state: 'done', content: 'final' }, [[1, 'x']])).toBe('final');
  });

  // A selected evidence tab hid Quick Actions and the coach with the rest of
  // the column, so one stray click looked like every button was gone
  // mid-meeting (2026-09-25). They stay, and the evidence renders below them.
  it('keeps Quick Actions and the coach on screen over an evidence tab', () => {
    const hide = /\.main\.ev-on > ([^{]+)\{ display: none !important; \}/.exec(PRESENT_HTML)?.[1] ?? '';
    expect(hide).toContain(':not(#quickActionsSlot)');
    expect(hide).toContain(':not(#coachDock)');
    const qa = PRESENT_HTML.indexOf('<div id="quickActionsSlot">');
    const coach = PRESENT_HTML.indexOf('<div id="coachDock">');
    const view = PRESENT_HTML.indexOf('<div id="evView"');
    expect(qa).toBeGreaterThan(-1);
    expect(view).toBeGreaterThan(coach);
    expect(coach).toBeGreaterThan(qa);
    // Stuck at top 0 they slid over the tab bar on scroll and hid the tabs.
    expect(PRESENT_HTML).toContain('#evTabBar:not([hidden]) ~ #quickActionsSlot { top: 16px;');
    expect(PRESENT_HTML).toContain('#evTabBar:not([hidden]) ~ #coachDock { top: calc(var(--qa-height, 0px) + 16px); }');
  });
});
