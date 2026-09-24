import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPresentRouter } from '../present/index.js';
import { evidenceView, openLiveTabs } from '../present/evidence.js';
import type { StagedTab } from '../prep/staged.js';

const SESSION = 'ec13fd2d-12e5-42cb-8fc0-6f39b1ec46fb';
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('openLiveTabs', () => {
  const tabs: StagedTab[] = [
    { title: 'A', url: 'https://a.example', path: null, note: '' },
    { title: 'Snapshot only', url: null, path: '/x.png', note: '' },
    { title: 'B', url: 'https://b.example', path: '/x.png', note: '' },
  ];

  it('opens every live URL, in order, and survives one that fails', async () => {
    const opened: string[] = [];
    const n = await openLiveTabs(tabs, async (url) => {
      if (url.includes('a.')) throw new Error('no browser');
      opened.push(url);
    });
    expect(n).toBe(1);
    expect(opened).toEqual(['https://b.example']);
  });

  it('opens nothing with COPILOT_OPEN_EVIDENCE=0', async () => {
    process.env.COPILOT_OPEN_EVIDENCE = '0';
    try {
      expect(await openLiveTabs(tabs, async () => { throw new Error('should not open'); })).toBe(0);
    } finally {
      delete process.env.COPILOT_OPEN_EVIDENCE;
    }
  });

  it('shows the dashboard no paths, and no snapshot whose file has gone', () => {
    const view = evidenceView(tabs, () => false);
    expect(view.map((t) => t.snapshot)).toEqual([null, null, null]);
    expect(JSON.stringify(view)).not.toContain('/x.png');
  });
});

describe('evidence routes', () => {
  let server: Server;
  let base: string;
  let home: string;
  const oldHome = process.env.HOME;
  const q = `?session=${SESSION}`;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'mc-ev-'));
    process.env.HOME = home;
    const dir = join(home, '.meeting-copilot', 'sessions', SESSION);
    const evidence = join(home, 'evidence');
    mkdirSync(dir, { recursive: true });
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, 'zero.png'), PNG);
    writeFileSync(join(evidence, 'page.html'), '<html><body><script>fetch("/present")</script>saved page</body></html>');
    writeFileSync(join(home, 'secret.txt'), 'not evidence');
    const tabs: StagedTab[] = [
      { title: 'Looker: 0 key events', url: 'https://lookerstudio.google.com/x', path: join(evidence, 'zero.png'), note: 'Brightline\'s own "dashboard"' },
      { title: 'Search Console', url: 'https://search.google.com/search-console', path: null, note: '' },
      { title: 'Saved page', url: null, path: join(evidence, 'page.html'), note: '' },
      { title: 'Gone', url: null, path: join(evidence, 'gone.png'), note: '' },
    ];
    writeFileSync(join(dir, 'prep.json'), JSON.stringify({ version: 1, id: 'abcdefabcdef', tabs }));

    const registry = Object.assign(new EventEmitter(), { getActionsByState: () => [], getAction: () => undefined });
    const app = express();
    app.use(createPresentRouter(registry as any, { getSessionId: () => SESSION }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('lists the session\'s tabs without their paths', async () => {
    const res = await fetch(`${base}/present/evidence${q}`);
    const { tabs } = await res.json() as { tabs: any[] };
    expect(tabs.map((t) => [t.title, t.url, t.snapshot?.kind ?? null])).toEqual([
      ['Looker: 0 key events', 'https://lookerstudio.google.com/x', 'image'],
      ['Search Console', 'https://search.google.com/search-console', null],
      ['Saved page', null, 'html'],
      ['Gone', null, null],
    ]);
    expect(JSON.stringify(tabs)).not.toContain(home);
    // The live session is the default; a bad id is refused.
    expect((await (await fetch(`${base}/present/evidence`)).json() as any).tabs).toHaveLength(4);
    expect((await fetch(`${base}/present/evidence?session=../../etc`)).status).toBe(400);
  });

  it('serves a snapshot by index, and nothing else', async () => {
    const png = await fetch(`${base}/present/evidence/0/file${q}`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await png.arrayBuffer()).equals(PNG)).toBe(true);
    for (const bad of ['1', '3', '4', '-1', 'x', '..%2Fsecret.txt']) {
      expect((await fetch(`${base}/present/evidence/${bad}/file${q}`)).status, bad).toBe(404);
    }
  });

  it('sends an html snapshot sandboxed, like a mockup', async () => {
    const res = await fetch(`${base}/present/evidence/2/file${q}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
    const view = await fetch(`${base}/present/evidence/2/view${q}`, { redirect: 'manual' });
    expect(view.status).toBe(302);
    expect(view.headers.get('location')).toBe(`/present/evidence/2/file${q}`);
  });

  it('opens a snapshot as a kit page with its note and live link', async () => {
    const res = await fetch(`${base}/present/evidence/0/view${q}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('JetBrains Mono');
    expect(body).toContain('Looker: 0 key events');
    expect(body).toContain('Brightline&#39;s own &quot;dashboard&quot;'.replace('&#39;', "'"));
    expect(body).toContain(`src="/present/evidence/0/file${q}"`);
    expect(body).toContain('href="https://lookerstudio.google.com/x"');
    expect((await fetch(`${base}/present/evidence/9/view${q}`)).status).toBe(404);
  });
});
