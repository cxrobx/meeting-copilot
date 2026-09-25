import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import {
  buildMeetingSnapshot,
  htmlToText,
  normalizeAttachments,
  renderUserTurn,
  transcriptSection,
  type MeetingSnapshotInput,
} from '../chat/context.js';
import { ChatError, ChatService, historyFor, type ChatAnswerRequest, type ChatEvent } from '../chat/service.js';
import { readChat, writeChat, type ChatMessage } from '../chat/store.js';
import { createPresentRouter } from '../present/index.js';
import { SELECTION_BRIDGE_SCRIPT, withSelectionBridge } from '../present/evidence.js';

const T0 = new Date('2026-09-25T14:00:00').getTime();
const MIN = 60_000;

function snapshotInput(over: Partial<MeetingSnapshotInput> = {}): MeetingSnapshotInput {
  return {
    title: 'Northwind weekly', attendees: 'Rory, Eli', startedAt: T0, endedAt: null, live: true, now: T0 + 23 * MIN,
    agenda: '', goals: '', brief: '', docs: '', pulse: null, tabs: [], cards: [], transcript: [], summaries: [],
    ...over,
  };
}

describe('transcriptSection', () => {
  const lines = [
    { label: '[You]', text: 'Did the Looker board ever count key events?', timestamp: T0 + 65_000 },
    { label: '[Meeting]', text: 'It shows zero, we are fixing the tag.', timestamp: T0 + 80_000 },
    { label: '[You]', text: 'When?', timestamp: T0 + 62 * MIN },
  ];

  it('keeps the whole meeting word for word when it fits, with times and speakers', () => {
    expect(transcriptSection(lines, [], T0)).toBe([
      '[1:05] You: Did the Looker board ever count key events?',
      '[1:20] Meeting: It shows zero, we are fixing the tag.',
      '[1:02:00] You: When?',
    ].join('\n'));
  });

  it('keeps the newest lines and carries the older ones by their summaries', () => {
    const out = transcriptSection(lines, [
      { summary: 'They discussed the Looker board.', windowStart: T0 + 65_000, windowEnd: T0 + 80_000 },
      { summary: 'Later, after the cut.', windowStart: T0 + 62 * MIN, windowEnd: T0 + 62 * MIN },
    ], T0, 60);
    expect(out).toContain('Earlier, summarized (2 lines not shown word for word)');
    expect(out).toContain('- [1:05–1:20] They discussed the Looker board.');
    expect(out).not.toContain('Later, after the cut.');
    expect(out).toContain('Word for word from [1:02:00]:\n[1:02:00] You: When?');
    expect(out).not.toContain('fixing the tag');
  });

  it('says how much it left out when nothing summarizes it, and always keeps the newest line', () => {
    const out = transcriptSection(lines, [], T0, 5);
    expect(out).toContain('(2 earlier lines are not shown.)');
    expect(out).toContain('You: When?');
  });

  it('handles an empty meeting', () => {
    expect(transcriptSection([], [], T0)).toBe('Nothing has been said yet.');
  });
});

describe('buildMeetingSnapshot', () => {
  it('puts in every section that has something, and none that do not', () => {
    const out = buildMeetingSnapshot(snapshotInput({
      agenda: '[covered] Budget\n[pending] Timeline',
      goals: 'Get a date for the tag fix',
      brief: 'Rory runs marketing at Northwind.',
      tabs: [{ title: 'Looker: 0 key events', url: 'https://looker.example', note: 'their dashboard' }],
      pulse: { status: 'drifting', read: 'Stuck on the dashboard.', escalations: [{ text: 'Ask for a date', why: 'no owner' }], closeOut: [], missed: [], minutesIn: 20 },
      cards: [
        { title: 'Old card', type: 'fast-research', state: 'completed', text: 'old' },
        { title: 'GA4 key events', type: 'fast-research', state: 'completed', text: 'Key events replaced conversions.' },
      ],
      transcript: [{ label: '[Meeting]', text: 'Zero key events.', timestamp: T0 + 60_000 }],
    }));
    expect(out).toContain('Title: Northwind weekly');
    expect(out).toContain('Attendees: Rory, Eli');
    expect(out).toContain('Live now, 23 minutes in');
    expect(out).toContain('## Agenda\n[covered] Budget');
    expect(out).toContain("## The user's private goals for this meeting\nGet a date");
    expect(out).toContain('## Prep brief');
    expect(out).toContain('- Looker: 0 key events <https://looker.example>: their dashboard');
    expect(out).toContain('Minute 20: drifting. Stuck on the dashboard.\nEscalate now:\n- Ask for a date (no owner)');
    // Newest card first.
    expect(out.indexOf('### GA4 key events')).toBeLessThan(out.indexOf('### Old card'));
    expect(out).toContain('[1:00] Meeting: Zero key events.');
    expect(out).not.toContain('## Reference documents');
  });

  it('says how long an ended meeting ran', () => {
    const out = buildMeetingSnapshot(snapshotInput({ live: false, endedAt: T0 + 41 * MIN }));
    expect(out).toContain('Ended after 41 minutes');
    expect(out).toContain('Nothing has been said yet.');
  });
});

describe('attachments', () => {
  it('keeps at most six well-formed ones and drops the rest', () => {
    const raw = [
      { kind: 'quote', label: 'Transcript', text: '  zero key events  ', context: 'the line around it' },
      { kind: 'nonsense', text: 'x' },
      { kind: 'card', label: 'GA4', text: '' },
      { kind: 'tab', label: 'whatever the client says', tabIndex: 2, text: '/etc/passwd' },
      { kind: 'tab', tabIndex: -1 },
      'not an object',
      ...Array.from({ length: 8 }, (_, i) => ({ kind: 'pulse', label: `P${i}`, text: 'read' })),
    ];
    const out = normalizeAttachments(raw);
    expect(out).toHaveLength(6);
    expect(out[0]).toEqual({ kind: 'quote', label: 'Transcript', text: 'zero key events', context: 'the line around it' });
    expect(out[1]).toMatchObject({ kind: 'tab', tabIndex: 2 });
    expect(out.slice(2).every((a) => a.kind === 'pulse')).toBe(true);
    expect(normalizeAttachments('nope')).toEqual([]);
  });

  it('numbers them ahead of the question', () => {
    const turn = renderUserTurn('Is that right?', [
      { kind: 'quote', label: 'Transcript', text: 'zero key events', context: 'Rory: our board shows zero key events' },
      { kind: 'card', label: 'GA4 key events', text: 'Key events replaced conversions.' },
    ]);
    expect(turn).toBe([
      'Attached:',
      '[1] Highlighted in Transcript: "zero key events"',
      '    Around it: Rory: our board shows zero key events',
      '[2] Card "GA4 key events": Key events replaced conversions.',
      '',
      'Is that right?',
    ].join('\n'));
    expect(renderUserTurn('  just a question ', [])).toBe('just a question');
  });

  it('reads an html snapshot as text, without its scripts', () => {
    expect(htmlToText('<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Zero</h1><p>key&nbsp;events &amp; tags</p></body></html>'))
      .toBe('Zero\nkey events & tags');
  });
});

describe('historyFor', () => {
  const m = (id: string, role: 'user' | 'assistant', content: string, state: ChatMessage['state'] = 'done'): ChatMessage =>
    ({ id, role, content, attachments: [], origin: 'dashboard', state, createdAt: 0 });

  it('sends finished exchanges before the question, and skips failed ones', () => {
    const thread = [m('q1', 'user', 'first'), m('a1', 'assistant', 'one'), m('q2', 'user', 'second'), m('a2', 'assistant', '', 'error'), m('q3', 'user', 'third')];
    expect(historyFor(thread, 'q3')).toEqual([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'one' }]);
    expect(historyFor(thread, 'q1')).toEqual([]);
  });
});

// ─── The service, against a real session DB ─────────────────────────────────

const SESSION = '5f0c2f6e-0d7a-4c1e-9d1b-1e3f5a7c9b2d';

function makeSession(root: string): string {
  const dir = join(root, SESSION);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'session.db'));
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, projectNames TEXT, agenda TEXT, attendees TEXT, startedAt INTEGER, endedAt INTEGER, state TEXT);
    CREATE TABLE transcript (id TEXT PRIMARY KEY, sessionId TEXT, text TEXT, source TEXT, label TEXT, timestamp INTEGER, duration REAL, wordCount INTEGER, redacted INTEGER);
    CREATE TABLE action (id TEXT PRIMARY KEY, sessionId TEXT, type TEXT, title TEXT, description TEXT, triggerQuote TEXT, state TEXT, params TEXT, result TEXT, createdAt INTEGER, approvedAt INTEGER, startedAt INTEGER, completedAt INTEGER);
  `);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(SESSION, 'Northwind weekly', '[]', 'Budget\nTimeline', 'Rory', T0, null, 'active');
  db.prepare('INSERT INTO transcript VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('t1', SESSION, 'Our Looker board shows zero key events.', 'meeting', '[Meeting]', T0 + 90_000, 0, 7, 0);
  db.prepare('INSERT INTO action VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'a1', SESSION, 'fast-research', 'GA4 key events', '', '', 'completed', '{}',
    JSON.stringify({ success: true, summary: 's', data: null, artifacts: [{ type: 'markdown', content: 'Key events replaced conversions in 2024.' }] }),
    T0 + 100_000, null, null, T0 + 110_000,
  );
  db.prepare('INSERT INTO action VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'a2', SESSION, 'fast-research', 'Expired idea', '', '', 'expired', '{}', null, T0 + 120_000, null, null, null,
  );
  db.close();
  const evidence = join(root, 'evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'page.html'), '<html><body><script>steal()</script><h1>Key events: 0</h1></body></html>');
  writeFileSync(join(dir, 'prep.json'), JSON.stringify({
    brief: 'Rory runs marketing at Northwind.',
    tabs: [
      { title: 'Search Console', url: 'https://search.google.com', path: null, note: '' },
      { title: 'Saved Looker page', url: null, path: join(evidence, 'page.html'), note: 'their board' },
    ],
  }));
  return dir;
}

type Scripted = (req: ChatAnswerRequest) => Promise<{ text: string; sources: Array<{ url: string; title: string }>; via: string }>;

describe('ChatService', () => {
  let root: string;
  let events: ChatEvent[];
  let calls: ChatAnswerRequest[];
  let script: Scripted;
  let service: ChatService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-chat-'));
    makeSession(root);
    events = [];
    calls = [];
    script = async (req) => {
      req.onDelta('Zero ');
      req.onDelta('key events.');
      return { text: 'Zero key events.', sources: [{ url: 'https://support.google.com/x', title: 'GA4 help' }], via: 'fake' };
    };
    service = new ChatService({
      sessionDir: (id) => join(root, id),
      liveContext: () => ({ live: true, agenda: '[covered] Budget', goals: 'Get a date', docs: (hint) => `docs for: ${hint}` }),
      broadcast: (e) => events.push(e),
      answer: (req) => { calls.push(req); return script(req); },
      now: () => T0 + 10 * MIN,
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('answers with the meeting as context, streams it, and saves the thread', async () => {
    const mine: ChatEvent[] = [];
    const turn = service.send({ sessionId: SESSION, text: 'What did Rory say about key events?' }, (e) => mine.push(e));
    expect(turn.user.state).toBe('done');
    expect(turn.assistant.state).toBe('streaming');
    const done = await turn.done;
    expect(done.state).toBe('done');
    expect(done.content).toBe('Zero key events.\n\n**Sources:** [GA4 help](https://support.google.com/x)');
    expect(done.via).toBe('fake');

    const system = calls[0]!.system;
    expect(system).toContain('[1:30] Meeting: Our Looker board shows zero key events.');
    expect(system).toContain('### GA4 key events (fast-research)\nKey events replaced conversions in 2024.');
    expect(system).not.toContain('Expired idea');
    expect(system).toContain('[covered] Budget'); // the live agenda wins over the stored text
    expect(system).toContain('Get a date');
    expect(system).toContain('Rory runs marketing at Northwind.');
    expect(system).toContain('docs for: What did Rory say about key events?');
    expect(calls[0]!.user).toBe('What did Rory say about key events?');

    expect(events.map((e) => (e.type === 'chat.delta' ? `delta:${e.text.trim()}` : `${e.message.role}:${e.message.state}`))).toEqual([
      'user:done', 'assistant:streaming', 'delta:Zero', 'delta:key events.', 'delta:**Sources:** [GA4 help](https://support.google.com/x)', 'assistant:done',
    ]);
    expect(mine).toEqual(events);
    expect(events.filter((e) => e.type === 'chat.delta').map((e) => (e as { seq: number }).seq)).toEqual([1, 2, 3]);
    expect(service.thread(SESSION).map((m) => [m.role, m.state, m.content.slice(0, 16)])).toEqual([
      ['user', 'done', 'What did Rory sa'],
      ['assistant', 'done', 'Zero key events.'],
    ]);
  });

  it('answers in order, each turn seeing the ones before it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    script = async (req) => {
      if (calls.length === 1) await gate;
      return { text: `answer ${calls.length}`, sources: [], via: 'fake' };
    };
    const first = service.send({ sessionId: SESSION, text: 'first' });
    const second = service.send({ sessionId: SESSION, text: 'and then?' });
    expect(service.busy(SESSION)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1); // the second waits for the first
    release();
    await first.done;
    await second.done;
    expect(calls[1]!.history).toEqual([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer 1' }]);
    expect(service.busy(SESSION)).toBe(false);
  });

  it('fills an evidence tab from prep.json, never from what the client sent', async () => {
    await service.send({
      sessionId: SESSION,
      text: 'Is this the same number?',
      attachments: [{ kind: 'tab', tabIndex: 1, label: 'fake', text: 'fake text' }, { kind: 'tab', tabIndex: 9 }],
    }).done;
    const user = calls[0]!.user;
    expect(user).toContain('[1] Evidence tab "Saved Looker page": Saved Looker page');
    expect(user).toContain('Note: their board');
    expect(user).toContain('Page text:\nKey events: 0');
    expect(user).not.toContain('steal()');
    expect(user).not.toContain('fake text');
    expect(user).not.toContain('[2]'); // index 9 does not exist
    expect(service.thread(SESSION)[0]!.attachments).toHaveLength(1);
  });

  it('keeps what streamed when stopped, and says why when it fails', async () => {
    script = (req) => new Promise((_resolve, reject) => {
      req.onDelta('Half an');
      req.signal.addEventListener('abort', () => reject(new Error('Aborted')));
    });
    const turn = service.send({ sessionId: SESSION, text: 'long one' });
    await new Promise((r) => setTimeout(r, 10));
    expect(service.cancel(SESSION)).toBe(1);
    expect(await turn.done).toMatchObject({ state: 'cancelled', content: 'Half an' });

    // The OpenAI SDK's shape: an aborted stream returns what it had.
    script = (req) => new Promise((resolve) => {
      req.onDelta('## Northwind next');
      req.signal.addEventListener('abort', () => resolve({ text: '## Northwind next', sources: [], via: 'fake' }));
    });
    const quiet = service.send({ sessionId: SESSION, text: 'a long brief' });
    await new Promise((r) => setTimeout(r, 10));
    service.cancel(SESSION);
    expect(await quiet.done).toMatchObject({ state: 'cancelled', content: '## Northwind next' });

    script = async () => { throw new Error('Per-session LLM budget reached ($10)'); };
    expect(await service.send({ sessionId: SESSION, text: 'again' }).done).toMatchObject({ state: 'error', error: 'Per-session LLM budget reached ($10)' });
    expect(service.thread(SESSION).map((m) => m.state)).toEqual(['done', 'cancelled', 'done', 'cancelled', 'done', 'error']);
  });

  it('refuses a missing meeting and an empty question', () => {
    expect(() => service.send({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000000', text: 'hi' })).toThrow(ChatError);
    try {
      service.send({ sessionId: SESSION, text: '   ' });
    } catch (err) {
      expect((err as ChatError).status).toBe(400);
    }
    expect(service.thread(SESSION)).toEqual([]);
  });

  it('reads an answer the server lost mid-stream as interrupted', () => {
    const dbPath = join(root, SESSION, 'session.db');
    writeChat(dbPath, SESSION, { id: 'orphan', role: 'assistant', content: 'Half', attachments: [], origin: 'menubar', state: 'streaming', createdAt: 1 });
    expect(readChat(dbPath)[0]!.state).toBe('streaming');
    expect(service.thread(SESSION)[0]).toMatchObject({ state: 'error', origin: 'menubar', content: 'Half' });
  });
});

// ─── Routes ─────────────────────────────────────────────────────────────────

describe('chat routes', () => {
  let server: Server;
  let base: string;
  let home: string;
  let service: ChatService;
  const oldHome = process.env.HOME;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'mc-chatr-'));
    process.env.HOME = home;
    const sessions = join(home, '.meeting-copilot', 'sessions');
    makeSession(sessions);
    service = new ChatService({
      sessionDir: (id) => join(sessions, id),
      answer: async (req) => { req.onDelta('Zero.'); return { text: 'Zero.', sources: [], via: 'fake' }; },
    });
    const registry = Object.assign(new EventEmitter(), { getActionsByState: () => [], getAction: () => undefined });
    const app = express();
    app.use(express.json());
    let live: string | undefined = SESSION;
    app.use('/nolive', createPresentRouter(registry as any, { getSessionId: () => undefined, chat: service }));
    app.use(createPresentRouter(registry as any, { getSessionId: () => live, chat: service }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('streams a turn back over the POST, then lists it', async () => {
    const res = await fetch(`${base}/present/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'How many key events?' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    const events = [...body.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)].map((m) => [m[1], JSON.parse(m[2]!)]);
    expect(events.map(([e, d]) => (e === 'delta' ? `delta:${d.seq}:${d.text}` : `${d.role}:${d.state}`))).toEqual([
      'user:done', 'assistant:streaming', 'delta:1:Zero.', 'assistant:done',
    ]);
    const list = await (await fetch(`${base}/present/chat?session=${SESSION}`)).json() as { messages: ChatMessage[]; busy: boolean };
    expect(list.messages.map((m) => m.content)).toEqual(['How many key events?', 'Zero.']);
    expect(list.busy).toBe(false);
  });

  it('says why it cannot ask', async () => {
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post('/present/chat', { text: '' })).status).toBe(400);
    expect((await post('/present/chat?session=../x', { text: 'hi' })).status).toBe(400);
    expect((await post('/present/chat?session=aaaaaaaa-0000-4000-8000-000000000000', { text: 'hi' })).status).toBe(404);
    const none = await post('/nolive/present/chat', { text: 'hi' });
    expect(none.status).toBe(409);
    expect((await none.json() as { error: string }).error).toContain('No meeting yet');
    expect(await (await fetch(`${base}/nolive/present/chat`)).json()).toEqual({ sessionId: null, messages: [], busy: false });
    expect(await (await post('/present/chat/cancel', {})).json()).toEqual({ cancelled: 0 });
  });
});

describe('evidence selection bridge', () => {
  it('parses, and goes in before </body>', () => {
    expect(() => new Script(SELECTION_BRIDGE_SCRIPT)).not.toThrow();
    const out = withSelectionBridge('<html><body><p>hi</p></BODY></html>');
    expect(out.indexOf('mcEvidenceSelection')).toBeLessThan(out.indexOf('</BODY>'));
    expect(withSelectionBridge('<p>no body tag</p>')).toMatch(/^<p>no body tag<\/p><script>/);
  });
});
