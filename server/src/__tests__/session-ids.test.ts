import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isSessionId } from '../session/ids.js';
import { createPresentRouter } from '../present/index.js';
import { createRoutes } from '../routes.js';

describe('isSessionId', () => {
  it('accepts the only shape SessionStore mints', () => {
    expect(isSessionId('ec13fd2d-12e5-42cb-8fc0-6f39b1ec46fa')).toBe(true);
  });

  it.each(['', '..', '../../etc', '..%2F..%2Fx', '/abs/path', 'ec13fd2d-12e5-42cb-8fc0-6f39b1ec46fa/..', 'test-123'])(
    'refuses %j',
    (id) => expect(isSessionId(id)).toBe(false),
  );

  it('refuses a non-string', () => {
    expect(isSessionId(undefined)).toBe(false);
    expect(isSessionId(['ec13fd2d-12e5-42cb-8fc0-6f39b1ec46fa'])).toBe(false);
  });
});

// Every route that turns a caller's session id into a path, over HTTP, so a
// route added later without the check fails here rather than in the wild.
describe('session-id routes refuse traversal', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    // The least context createRoutes needs to build; the routes under test
    // must refuse the id before touching any of it.
    const ctx = {
      debug: { handler: () => (_req: unknown, res: any) => res.json({}), recordAudioChunk() {}, recordTranscriptWords() {} },
      getSession: () => ({ store: null, logger: null, active: false }),
      getWhisperAvailable: () => null,
      probeWhisperAvailable: async () => false,
      getRetentionDays: () => 30,
      setRetentionDays: () => {},
      transcription: {},
      intelligence: {},
      registry: {},
    } as any;
    app.use(createRoutes(ctx));
    // The dashboard router subscribes to registry events as it is built.
    const registry = Object.assign(new EventEmitter(), { getActionsByState: () => [] });
    app.use(createPresentRouter(registry as any));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const BAD = ['..%2F..%2F..%2Ftmp', 'not-a-session'];

  it.each(BAD)('GET /sessions/%s/export → 400', async (id) => {
    expect((await fetch(`${base}/sessions/${id}/export`)).status).toBe(400);
  });

  it.each(BAD)('DELETE /sessions/%s → 400', async (id) => {
    expect((await fetch(`${base}/sessions/${id}`, { method: 'DELETE' })).status).toBe(400);
  });

  it.each(['/present/actions', '/present/transcript', '/present/coach'])('GET %s?session=../../etc → 400', async (path) => {
    expect((await fetch(`${base}${path}?session=${encodeURIComponent('../../etc')}`)).status).toBe(400);
  });

  it('POST /present/review with a traversal id → 400', async () => {
    const res = await fetch(`${base}/present/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '../../etc' }),
    });
    expect(res.status).toBe(400);
  });

  it('a well-formed id that does not exist is a 404, not a 400', async () => {
    const res = await fetch(`${base}/present/transcript?session=00000000-0000-4000-8000-000000000000`);
    expect(res.status).toBe(404);
  });

  it('live /present/actions (no session param) still works', async () => {
    const res = await fetch(`${base}/present/actions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actions: [] });
  });
});
