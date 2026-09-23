import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PublishJobs, readPublished, type PublishStateMessage } from '../publish/index.js';
import { checkFragment, polishToPage } from '../publish/polish.js';
import type { Uploader } from '../publish/uploader.js';
import { createPresentRouter, findAction } from '../present/index.js';
import { PENDING_NOTE } from '../workers/deep-follow-up.js';

const SESSION = 'ec13fd2d-12e5-42cb-8fc0-6f39b1ec46fa';
const md = (content: string) => ({ success: true, data: {}, summary: 's', artifacts: [{ type: 'markdown' as const, content }] });
const research = { id: 'r1', type: 'fast-research', title: 'Best video APIs', state: 'completed', completedAt: 1, result: md('## Answer\n\nKling is good. [src](https://kling.ai)') };
const mockup = { id: 'm1', type: 'mockup', title: 'Mock', state: 'completed', result: { success: true, data: {}, summary: '', artifacts: [{ type: 'html' as const, content: '<!doctype html><html><head><title>m</title></head><body>mock</body></html>' }] } };

const GOOD_FRAGMENT = '<div class="callout tip"><span class="label">Bottom line</span><p>Kling.</p></div>\n<h2>Options</h2><p>See <a href="https://kling.ai">Kling</a>.</p>';

describe('checkFragment', () => {
  it('takes kit markup, gives headings ids, and opens links in a new tab', () => {
    const out = checkFragment('```html\n' + GOOD_FRAGMENT + '\n```');
    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect(out.html).toContain('<h2 id="options">Options</h2>');
    expect(out.html).toContain('target="_blank" rel="noopener"');
    expect(out.toc).toEqual([{ id: 'options', text: 'Options', level: 2 }]);
  });

  it('lifts a leading <h1> out as the page title', () => {
    const out = checkFragment('<h1>Best AI video APIs</h1>\n' + GOOD_FRAGMENT + '<h1>Stray</h1>');
    if ('error' in out) throw new Error(out.error);
    expect(out.title).toBe('Best AI video APIs');
    expect(out.html).not.toContain('<h1');
    expect(out.html).toContain('id="stray"');
  });

  it.each([
    ['<p>ok</p><script>alert(1)</script><p>padding padding padding</p>', 'script'],
    ['<p onclick="x()">padding padding padding padding padding</p>', 'handler'],
    ['<p style="color:red">padding padding padding padding padding</p>', 'style attribute'],
    ['<p><a href="javascript:alert(1)">x</a> padding padding padding</p>', 'javascript: link'],
    ['<html><body><p>a whole page, not a fragment of one at all</p></body></html>', 'whole document'],
    ['Here is your page! It is lovely and I hope you like it very much.', 'prose'],
  ])('refuses %j (%s)', (raw) => {
    expect('error' in checkFragment(raw)).toBe(true);
  });
});

describe('polishToPage', () => {
  const signal = new AbortController().signal;

  it('wraps the agent fragment in the kit shell, unindexed', async () => {
    const page = await polishToPage(research, async () => '<h1>Clean title</h1>' + GOOD_FRAGMENT, signal);
    expect(page.html).toContain('<title>Clean title</title>');
    expect(page.via).toBe('agent');
    expect(page.html).toContain('JetBrains Mono');
    expect(page.html).toContain('name="robots" content="noindex');
    expect(page.html).toContain('Bottom line');
  });

  it('falls back to the reader page when the agent writes something unusable', async () => {
    const page = await polishToPage(research, async () => '<p>A perfectly long paragraph.</p><script>alert(1)</script>', signal);
    expect(page.via).toBe('fallback');
    expect(page.reason).toMatch(/script/);
    expect(page.html).toContain('Kling is good.');
    expect(page.html).toContain('name="robots" content="noindex');
  });

  it('falls back when the agent call fails', async () => {
    const page = await polishToPage(research, async () => { throw new Error('CLI down'); }, signal);
    expect(page).toMatchObject({ via: 'fallback', reason: 'agent failed: CLI down' });
  });

  it('never sends the pending note to the agent', async () => {
    let prompt = '';
    await polishToPage({ ...research, result: md(`x\n\n${PENDING_NOTE}`) }, async (p) => { prompt = p; return GOOD_FRAGMENT; }, signal);
    expect(prompt).not.toContain(PENDING_NOTE);
  });

  it('sends a mockup as-is with noindex, without the agent', async () => {
    let called = false;
    const page = await polishToPage(mockup, async () => { called = true; return ''; }, signal);
    expect(called).toBe(false);
    expect(page.via).toBe('as-is');
    expect(page.html).toMatch(/<head>\n<meta name="robots"[^>]*><title>m<\/title>/);
  });
});

describe('PublishJobs', () => {
  let home: string;
  const oldHome = process.env.HOME;
  const live = new Map<string, any>();
  let messages: PublishStateMessage[];
  let store: Map<string, string>;
  let failPut: boolean;
  let gate: Promise<void>;
  let openGate: () => void;

  const uploader: Uploader = {
    async put(key, html) {
      await gate;
      if (failPut) throw new Error('Please enable R2 through the Cloudflare Dashboard.');
      store.set(key, html);
    },
    async remove(key) { store.delete(key); },
  };
  let n = 0;
  const jobs = () => new PublishJobs({
    find: (id, sessionId) => findAction({ getAction: (x: string) => live.get(x) } as any, id, sessionId ?? SESSION),
    polish: (action, signal) => polishToPage(action, async () => GOOD_FRAGMENT, signal),
    uploader,
    broadcast: (m) => messages.push(m),
    newKey: () => `key${++n}`,
  });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)); };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'mc-pub-'));
    process.env.HOME = home;
    mkdirSync(join(home, '.meeting-copilot', 'sessions', SESSION), { recursive: true });
    live.set('r1', research);
    live.set('m1', mockup);
    live.set('p1', { ...research, id: 'p1', result: md(`x\n\n${PENDING_NOTE}`) });
  });
  afterAll(() => {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });
  beforeEach(() => {
    messages = [];
    store = new Map();
    failPut = false;
    gate = Promise.resolve();
    rmSync(join(home, '.meeting-copilot', 'sessions', SESSION, 'published.json'), { force: true });
    rmSync(join(home, '.meeting-copilot', 'published.jsonl'), { force: true });
  });

  it('polishes, uploads, records, and reports each phase', async () => {
    const j = jobs();
    expect(j.start('r1', undefined)).toEqual({ ok: true, status: 202 });
    await settle();
    expect(messages.map((m) => m.phase)).toEqual(['polishing', 'uploading', 'done']);
    const url = messages[2].url!;
    expect(url).toMatch(/^https:\/\/share\.cxventures\.io\/key\d+$/);
    expect([...store.values()][0]).toContain('Bottom line');
    expect(readPublished(SESSION).r1).toMatchObject({ url, via: 'agent', title: 'Best video APIs' });
    const ledger = readFileSync(join(home, '.meeting-copilot', 'published.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ledger).toEqual([expect.objectContaining({ event: 'published', url, actionId: 'r1', sessionId: SESSION })]);
    // A second click on a published card hands back the same link.
    expect(j.start('r1', undefined)).toMatchObject({ ok: true, status: 200, record: { url } });
  });

  it('runs one job at a time', async () => {
    gate = new Promise((r) => { openGate = r; });
    const j = jobs();
    expect(j.start('r1', undefined).status).toBe(202);
    expect(j.start('r1', undefined)).toMatchObject({ ok: false, status: 409, error: 'Already publishing this card.' });
    expect(j.start('m1', undefined)).toMatchObject({ ok: false, status: 409 });
    openGate();
    await settle();
    expect(j.start('m1', undefined).status).toBe(202);
    await settle();
    expect(readPublished(SESSION).m1.via).toBe('as-is');
  });

  it('refuses a card whose deep research is still coming, and an unknown card', () => {
    const j = jobs();
    expect(j.start('p1', undefined)).toMatchObject({ ok: false, status: 409 });
    expect(j.start('nope', undefined)).toMatchObject({ ok: false, status: 404 });
  });

  it('reports a failed upload and records nothing', async () => {
    failPut = true;
    const j = jobs();
    j.start('r1', undefined);
    await settle();
    expect(messages.at(-1)).toMatchObject({ phase: 'failed', error: expect.stringMatching(/enable R2/) });
    expect(readPublished(SESSION)).toEqual({});
    expect(j.busy).toBeNull();
  });

  it('revokes: deletes the object, marks the record, logs it', async () => {
    const j = jobs();
    j.start('r1', undefined);
    await settle();
    expect(store.size).toBe(1);
    expect(await j.revoke('r1', SESSION)).toEqual({ ok: true });
    expect(store.size).toBe(0);
    expect(readPublished(SESSION).r1.revokedAt).toBeGreaterThan(0);
    expect(j.current('r1', SESSION)).toBeNull();
    expect(messages.at(-1)).toMatchObject({ phase: 'revoked', actionId: 'r1' });
    const events = readFileSync(join(home, '.meeting-copilot', 'published.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).event);
    expect(events).toEqual(['published', 'revoked']);
    expect(await j.revoke('r1', SESSION)).toMatchObject({ ok: false, status: 404 });
  });

  describe('routes', () => {
    let server: Server;
    let base: string;
    beforeAll(async () => {
      const registry = Object.assign(new EventEmitter(), { getActionsByState: () => [], getAction: (id: string) => live.get(id) });
      const app = express();
      app.use(createPresentRouter(registry as any, { getSessionId: () => SESSION, publish: jobs() }));
      await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

    it('publishes, lists, and unpublishes over HTTP', async () => {
      const post = await fetch(`${base}/present/action/r1/publish`, { method: 'POST' });
      expect(post.status).toBe(202);
      await settle();
      const listed = await (await fetch(`${base}/present/published`)).json() as any;
      expect(Object.keys(listed.records)).toEqual(['r1']);
      // What a page without a WebSocket (replay) polls for progress.
      expect(listed.jobs.r1).toMatchObject({ phase: 'done', url: listed.records.r1.url });
      expect((await fetch(`${base}/present/action/r1/publish`, { method: 'DELETE' })).status).toBe(200);
      expect(((await (await fetch(`${base}/present/published`)).json()) as any).records).toEqual({});
    });

    it('refuses a bad session id', async () => {
      expect((await fetch(`${base}/present/action/r1/publish?session=..%2Fx`, { method: 'POST' })).status).toBe(400);
      expect((await fetch(`${base}/present/published?session=..%2Fx`)).status).toBe(400);
    });

    it('never writes outside the session dir', () => {
      expect(existsSync(join(home, '.meeting-copilot', 'sessions', 'published.json'))).toBe(false);
    });
  });
});
