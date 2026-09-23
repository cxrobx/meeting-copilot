import { describe, expect, it } from 'vitest';
import { PRESENT_HTML } from '../present/index.js';

// Inside the app the page covers the whole panel, title bar included, and the
// web view takes every click, so the page's own bars are the only grip the
// window has (the app half is WindowDrag.swift). Rewriting the header markup
// without the attribute puts the window back to being draggable only by its
// one-point border, and nothing else would notice.
describe('/present window drag regions', () => {
  it('marks the header and Stage top bar as title bars', () => {
    expect(PRESENT_HTML).toMatch(/<div class="header"[^>]*\bdata-drag-region\b/);
    expect(PRESENT_HTML).toMatch(/<div class="stage-top"[^>]*\bdata-drag-region\b/);
  });

  it('hands presses in a region to the app, but never a control', () => {
    const script = PRESENT_HTML.slice(PRESENT_HTML.indexOf('// ─── Window drag'));
    expect(script).toContain("closest('[data-drag-region]')");
    expect(script).toContain('__copilotNativeBridge.startWindowDrag()');
    expect(script).toMatch(/var DRAG_EXEMPT = '[^']*\bbutton\b[^']*\binput\b[^']*\[data-no-drag\]/);
  });
});
