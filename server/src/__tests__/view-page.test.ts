import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPresentRouter } from '../present/index.js';
import { buildReaderPage, scriptSafeJson, viewContent, withNoindex } from '../present/view-page.js';
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
  it('cannot be broken out of by the markdown', () => {
    const hostile = 'before </script><script>window.pwned=1</script> after <!-- x';
    const page = buildReaderPage({ title: 'T', type: 'research', markdown: hostile, scripts: 'link' });
    // Exactly the three script elements the template writes (two vendor + one inline).
    expect(page.match(/<script\b/g)).toHaveLength(3);
    expect(page).not.toContain('</script><script>window.pwned');
    // And the JSON round-trips to the original text.
    expect(JSON.parse(scriptSafeJson(hostile))).toBe(hostile);
  });

  it('parses as JavaScript', () => {
    const page = buildReaderPage({ title: 'T', type: 'research', markdown: 'a \u2028 b `c` ${d}', scripts: 'link' });
    const inline = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    for (const code of inline) expect(() => new vm.Script(code)).not.toThrow();
  });

  it('inlines the libraries for a published page and asks to stay unindexed', () => {
    const page = buildReaderPage({ title: 'T', type: 'research', markdown: 'x', scripts: 'inline', noindex: true });
    expect(page).not.toContain('/vendor/js/');
    expect(page).toContain('marked');
    expect(page).toContain('DOMPurify');
    expect(page).toContain('name="robots" content="noindex');
  });

  it('escapes the title', () => {
    expect(buildReaderPage({ title: '<b>x</b>', type: 'research', markdown: 'x', scripts: 'link' })).toContain('&lt;b&gt;x&lt;/b&gt;');
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
    expect(body).toContain('**Live answer**');
    expect(body).toContain('http-equiv="refresh"');
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('opens a stored card through ?session=', async () => {
    const res = await fetch(`${base}/present/action/stored-1/view?session=${SESSION}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('## From the store');
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
