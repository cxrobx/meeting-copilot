import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ChatError, ChatService, type ChatEvent } from '../chat/service.js';
import { cleanTaskFields, personTag, readTaskDrafts } from '../chat/tasks.js';
import { dueDateToIso, fileTaskArgs, fileViaMcp, parseFiled, type CxTaskInput } from '../cxtasks/client.js';

const SESSION = '5f0c2f6e-0d7a-4c1e-9d1b-1e3f5a7c9b2d';
const T0 = new Date('2026-10-02T14:00:00').getTime();

function makeSession(root: string): void {
  const dir = join(root, SESSION);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'session.db'));
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, agenda TEXT, attendees TEXT, startedAt INTEGER, endedAt INTEGER)');
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(SESSION, 'Northwind weekly', '', 'Rory', T0, null);
  db.close();
}

describe('cleanTaskFields', () => {
  it('needs a title, and keeps priority, due date and people inside their bounds', () => {
    expect(cleanTaskFields({ title: '  ' })).toBeNull();
    expect(cleanTaskFields({ title: ' Send  the deck ', notes: 'n', priority: 7, due: 'Friday', people: ['@Rory', 'Rory', '', 3] })).toEqual({
      title: 'Send the deck', body: 'n', priority: 2, due: '', people: ['Rory'],
    });
    expect(cleanTaskFields({ title: 'x', priority: '0', due: '2026-10-09' })).toMatchObject({ priority: 0, due: '2026-10-09' });
  });

  it('turns a person into a CXTasks tag', () => {
    expect(personTag('Mary Ann')).toBe('@mary-ann');
  });
});

describe('the CXTasks client', () => {
  it('sends only fields file_task knows, why always chris-asked, never a prompt', () => {
    const task = { title: 'T', body: 'B', priority: 1, dueAt: '2026-10-09T21:00:00.000Z', tags: ['meeting'], repoPath: '/nope/not/here', prompt: 'rm -rf' } as CxTaskInput;
    expect(fileTaskArgs(task)).toEqual({ title: 'T', why: 'chris-asked', body: 'B', priority: 1, due_at: '2026-10-09T21:00:00.000Z', tags: ['meeting'] });
    expect(fileTaskArgs({ title: 'T', repoPath: tmpdir() }).repo_path).toBe(tmpdir());
  });

  it('reads the T-number and id from file_task\'s printout', () => {
    expect(parseFiled('Filed task.\n\nSend the deck\n  ref:        T232\n  id:         3200587a-f0d3-4f2f-9446-791c4b4ac537\n')).toEqual({
      ref: 'T232', id: '3200587a-f0d3-4f2f-9446-791c4b4ac537',
    });
    expect(parseFiled('nothing here')).toBeNull();
  });

  it('makes a picked date 17:00 local that day, and refuses a date that does not exist', () => {
    expect(new Date(dueDateToIso('2026-10-09')!).getHours()).toBe(17);
    expect(dueDateToIso('2026-02-30')).toBeNull();
    expect(dueDateToIso('Friday')).toBeNull();
  });

  describe('against a stand-in MCP server', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mc-cxmcp-')); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    // Speaks just enough MCP: answers initialize, records the tools/call, prints a filed task.
    function fakeMcp(reply: string): string {
      const bin = join(dir, 'fake-mcp');
      writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }) + '\\n');
    if (msg.method === 'tools/call') {
      fs.writeFileSync(${JSON.stringify(join(dir, 'call.json'))}, JSON.stringify(msg.params));
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: ${reply} }) + '\\n');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`);
      chmodSync(bin, 0o755);
      return bin;
    }

    it('initializes, calls file_task with the arguments, and returns what was filed', async () => {
      const bin = fakeMcp(`{ content: [{ type: 'text', text: 'Filed task.\\n\\nX\\n  ref:        T999\\n  id:         00000000-0000-4000-8000-000000000999\\n' }] }`);
      const filed = await fileViaMcp(bin, { title: 'X', why: 'chris-asked' });
      expect(filed).toEqual({ ref: 'T999', id: '00000000-0000-4000-8000-000000000999' });
      expect(JSON.parse(readFileSync(join(dir, 'call.json'), 'utf8'))).toEqual({ name: 'file_task', arguments: { title: 'X', why: 'chris-asked' } });
    });

    it('reports a refusal in CXTasks\' own words', async () => {
      const bin = fakeMcp(`{ isError: true, content: [{ type: 'text', text: 'repo_path does not exist' }] }`);
      await expect(fileViaMcp(bin, { title: 'X', why: 'chris-asked' })).rejects.toThrow('repo_path does not exist');
    });

    it('says so when CXTasks is missing, and when it never answers', async () => {
      await expect(fileViaMcp(join(dir, 'absent'), {})).rejects.toThrow('not installed');
      const bin = join(dir, 'silent');
      writeFileSync(bin, `#!${process.execPath}\nprocess.stdin.resume();\n`);
      chmodSync(bin, 0o755);
      await expect(fileViaMcp(bin, {}, 300)).rejects.toThrow('did not answer');
    });
  });
});

describe('task drafts in the chat', () => {
  let root: string;
  let events: ChatEvent[];
  let filed: CxTaskInput[];
  let fail: string | null;
  let service: ChatService;
  let drafts: unknown[] | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-chat-tasks-'));
    makeSession(root);
    events = [];
    filed = [];
    fail = null;
    drafts = [{ title: 'Send Rory the Q4 deck', notes: 'He asked at [12:04].', priority: 1, due: '2026-10-09', people: ['Rory'] }];
    service = new ChatService({
      sessionDir: (id) => join(root, id),
      broadcast: (e) => events.push(e),
      answer: async () => ({ text: '', sources: [], via: 'fake', taskDrafts: drafts as never }),
      fileTask: async (task) => {
        if (fail) throw new Error(fail);
        filed.push(task);
        return { ref: `T${900 + filed.length}`, id: `00000000-0000-4000-8000-00000000090${filed.length}` };
      },
      repoFor: () => '/Users/x/Projects/northwind',
      now: () => T0 + 10 * 60_000,
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('turns a draft_task call into a draft under the answer, and files nothing by itself', async () => {
    const done = await service.send({ sessionId: SESSION, text: 'make a task to send Rory the deck by next Friday' }).done;
    expect(done.content).toBe('Drafted a task. Check, then press File.');
    expect(done.drafts).toHaveLength(1);
    expect(done.drafts![0]).toMatchObject({ title: 'Send Rory the Q4 deck', priority: 1, due: '2026-10-09', people: ['Rory'], state: 'draft', source: 'chat' });
    expect(filed).toEqual([]);
    // The thread reloads with it.
    expect(service.thread(SESSION)[1]!.drafts![0]!.state).toBe('draft');
  });

  it('tells the model today\'s date so "next Friday" resolves', async () => {
    let system = '';
    service = new ChatService({ sessionDir: (id) => join(root, id), answer: async (req) => { system = req.system; return { text: 'ok', sources: [], via: 'f' }; }, now: () => T0 });
    await service.send({ sessionId: SESSION, text: 'hi' }).done;
    expect(system).toContain('Today is Friday, October 2, 2026.');
    expect(system).toContain('draft_task');
  });

  it('files on File with the user\'s edits, the meeting in the notes, people as tags, and the meeting\'s repo', async () => {
    const done = await service.send({ sessionId: SESSION, text: 'task please' }).done;
    const id = done.drafts![0]!.id;
    events = [];
    const result = await service.fileDraft({ sessionId: SESSION, draftId: id, fields: { title: 'Send Rory the deck', body: 'Edited.', priority: '0', due: '' } });
    expect(result).toMatchObject({ state: 'filed', taskRef: 'T901', title: 'Send Rory the deck', priority: 0, due: '' });
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ title: 'Send Rory the deck', priority: 0, dueAt: undefined, tags: ['meeting', '@rory'], repoPath: '/Users/x/Projects/northwind' });
    expect(filed[0]!.body).toBe(`Edited.\n\nFrom "Northwind weekly" on Oct 2, 2026, via Meeting Copilot (session \`${SESSION}\`).`);
    // Filing, then filed, both go out with the message.
    expect(events.map((e) => (e.type === 'chat.message' ? e.message.drafts?.[0]?.state : e.type))).toEqual(['filing', 'filed']);
    expect(readTaskDrafts(join(root, SESSION, 'session.db'))[0]).toMatchObject({ state: 'filed', taskRef: 'T901' });
  });

  it('never files the same draft twice, and refuses one that was dismissed', async () => {
    drafts = [{ title: 'A', notes: '', priority: 2, due: null, people: [] }, { title: 'B', notes: '', priority: 2, due: null, people: [] }];
    const done = await service.send({ sessionId: SESSION, text: 'two tasks' }).done;
    const [a, b] = done.drafts!;
    const first = service.fileDraft({ sessionId: SESSION, draftId: a!.id });
    await expect(service.fileDraft({ sessionId: SESSION, draftId: a!.id })).rejects.toThrow('Already filing');
    await first;
    await expect(service.fileDraft({ sessionId: SESSION, draftId: a!.id })).rejects.toThrow('Already filed as T901');
    expect(service.dismissDraft({ sessionId: SESSION, draftId: b!.id }).state).toBe('dismissed');
    await expect(service.fileDraft({ sessionId: SESSION, draftId: b!.id })).rejects.toBeInstanceOf(ChatError);
    expect(filed).toHaveLength(1);
  });

  it('keeps a failed filing as a draft that says why and can be tried again', async () => {
    const done = await service.send({ sessionId: SESSION, text: 'task' }).done;
    fail = 'CXTasks is not installed';
    const failed = await service.fileDraft({ sessionId: SESSION, draftId: done.drafts![0]!.id });
    expect(failed).toMatchObject({ state: 'error', error: 'CXTasks is not installed' });
    fail = null;
    expect((await service.fileDraft({ sessionId: SESSION, draftId: done.drafts![0]!.id })).state).toBe('filed');
  });

  it('drafts a pulse item into the chat as its own turn, without asking a model', () => {
    const message = service.draftFromPulse({ sessionId: SESSION, text: 'Agree who owns the tag fix, by Friday', why: 'Nobody took it.' });
    expect(message).toMatchObject({ role: 'assistant', state: 'done', via: 'pulse' });
    expect(message.drafts![0]).toMatchObject({ title: 'Agree who owns the tag fix, by Friday', body: 'From the meeting pulse: Nobody took it.', source: 'pulse', state: 'draft' });
    expect(events).toHaveLength(1);
    expect(service.thread(SESSION).map((m) => m.via)).toEqual(['pulse']);
    expect(() => service.draftFromPulse({ sessionId: SESSION, text: ' ' })).toThrow(ChatError);
  });
});
