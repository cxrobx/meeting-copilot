import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPresentRouter } from '../present/index.js';
import { buildReaderPage, viewContent, withNoindex } from '../present/view-page.js';
import { PENDING_NOTE } from '../workers/deep-follow-up.js';

const SESSION = 'ec13fd2d-12e5-42cb-8fc0-6f39b1ec46fa';

const md = (content: string) => ({ success: true, data: {}, summary: 's', artifacts: [{ type: 'markdown' as const, content }] });

describe('viewContent', () => {
  it('sends an html artifact as the page', () => {
    const c = viewContent({ id: 'a', type: 'mockup', title: 't', result: { success: true, data: {}, summary: '', artifacts: [{ type: 'code', content: 'ascii' }, { type: 'html', content: '<html>x</html>' }] } });
    expect(c).toEqual({ kind: 'html', html: '<html>x</html>' });
  });

  it('flags a card whose deep follow-up is still coming', () => {
    const c = viewContent({ id: 'a', type: 'fast-research', title: 't', result: md(`answer\n\n${PENDING_NOTE}`) });
    expect(c).toMatchObject({ kind: 'markdown', pending: true });
  });

  it('has nothing to show for a card without a result', () => {
    expect(viewContent({ id: 'a', type: 'research', title: 't', result: null })).toBeNull();
  });
});

describe('buildReaderPage', () => {
  const page = (markdown: string, extra: Partial<Parameters<typeof buildReaderPage>[0]> = {}) =>
    buildReaderPage({ title: 'T', type: 'research', markdown, ...extra });

  it('wears the HTML Artifact Kit', () => {
    const out = page('## One\n\ntext\n\n## Two\n\n### Two a\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(out).toContain('JetBrains Mono');
    expect(out).toContain('prefers-color-scheme: dark');
    expect(out).toContain('<div class="table-scroll"><table>');
    // An authored nav, so it reads with JS off; no level radios on a one-altitude page.
    expect(out).toContain('<li class="h2"><a href="#one">One</a></li>');
    expect(out).toContain('<li class="h3"><a href="#two-a">Two a</a></li>');
    expect(out).not.toContain('name="lvl"');
    expect(out).not.toMatch(/{{[A-Z]+}}/);
  });

  it('keeps one h1 when the card uses #', () => {
    const out = page('# Big\n\n## Small');
    expect(out).toContain('<h2 id="big">Big</h2>');
    expect(out).toContain('<h3 id="small">Small</h3>');
  });

  it('shows raw HTML as text and drops unsafe links', () => {
    const out = page('before <script>window.pwned=1</script> [x](javascript:alert(1)) [ok](https://example.com) $& $1');
    expect(out).not.toContain('<script>window.pwned');
    expect(out).toContain('&lt;script&gt;window.pwned');
    expect(out).not.toContain('javascript:alert');
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener">ok</a>');
    expect(out).toContain('$&amp; $1');
  });

  it('refreshes and stays unindexed only when asked', () => {
    expect(page('x')).not.toContain('http-equiv="refresh"');
    expect(page('x', { refresh: true, noindex: true })).toMatch(/http-equiv="refresh"[\s\S]*<\/head>/);
    expect(page('x', { noindex: true })).toContain('name="robots" content="noindex');
  });

  it('drops a first line that restates the title', () => {
    const out = page('### Research: best APIs?\n\n## Body', { title: 'Research: best APIs?' });
    expect(out).not.toContain('<h3 id="research-best-apis">');
    expect(out).toContain('<h2 id="body">Body</h2>');
    expect(page('**Other**\n\ntext', { title: 'T' })).toContain('<strong>Other</strong>');
  });

  it('escapes the title', () => {
    expect(page('x', { title: '<b>x</b>' })).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('withNoindex', () => {
  it('adds the tag once, inside <head>', () => {
    const out = withNoindex('<!doctype html><html><head><title>x</title></head><body></body></html>');
    expect(out).toMatch(/<head>\n<meta name="robots"/);
    expect(withNoindex(out)).toBe(out);
  });
});

describe('GET /present/action/:id/view', () => {
  let server: Server;
  let base: string;
  let home: string;
  const oldHome = process.env.HOME;
  const live = new Map<string, any>();

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'mc-view-'));
    process.env.HOME = home;
    const dir = join(home, '.meeting-copilot', 'sessions', SESSION);
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, 'session.db'));
    db.exec('CREATE TABLE action (id TEXT PRIMARY KEY, type TEXT, title TEXT, result TEXT, completedAt INTEGER)');
    db.prepare('INSERT INTO action VALUES (?, ?, ?, ?, ?)').run('stored-1', 'analysis', 'Stored analysis', JSON.stringify(md('## From the store')), Date.now());
    db.close();

    live.set('live-1', { id: 'live-1', type: 'fast-research', title: 'Live research', state: 'completed', result: md(`**Live answer**\n\n${PENDING_NOTE}`) });
    live.set('mock-1', { id: 'mock-1', type: 'mockup', title: 'Mock', state: 'completed', result: { success: true, data: {}, summary: '', artifacts: [{ type: 'html', content: '<html><body>mock</body></html>' }] } });

    const registry = Object.assign(new EventEmitter(), {
      getActionsByState: () => [],
      getAction: (id: string) => live.get(id),
    });
    const app = express();
    app.use(createPresentRouter(registry as any));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('opens a live card as a reader page that refreshes while deep research is pending', async () => {
    const res = await fetch(`${base}/present/action/live-1/view`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('Live research');
    expect(body).toContain('<strong>Live answer</strong>');
    expect(body).toContain('http-equiv="refresh"');
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('opens a stored card through ?session=', async () => {
    const res = await fetch(`${base}/present/action/stored-1/view?session=${SESSION}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('From the store</h2>');
    expect(body).not.toContain('http-equiv="refresh"');
  });

  it('serves a mockup as-is under a sandbox CSP', async () => {
    const res = await fetch(`${base}/present/action/mock-1/view`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
    expect(await res.text()).toBe('<html><body>mock</body></html>');
  });

  it('404s an unknown card', async () => {
    expect((await fetch(`${base}/present/action/nope/view`)).status).toBe(404);
    expect((await fetch(`${base}/present/action/nope/view?session=${SESSION}`)).status).toBe(404);
  });

  it('refuses a session id that is not one', async () => {
    expect((await fetch(`${base}/present/action/stored-1/view?session=..%2F..%2Ftmp`)).status).toBe(400);
  });
});
