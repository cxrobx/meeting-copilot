import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  gatherPrepContext,
  formatPrepContext,
  prepRequestFromBody,
  stripQuotedReply,
  type PrepRequest,
} from '../prep/gather.js';
import { parsePrepResponse, runMeetingPrep, describeToolUse } from '../prep/agent.js';

// Modeled on the 2026-09-21 Winslow meeting: an intro from a mutual friend,
// the attendee's reply, scheduling-bot back-and-forth, and the calendar
// invite email itself.
const MEETING_REQUEST: PrepRequest = {
  title: 'Meets: Christopher (CX) / Winslow (Harbor Ventures)',
  attendees: [
    { name: 'Winslow Hart', email: 'winslow@harborventures.example' },
    { name: 'chris', email: 'chris@example.org' },
  ],
  organizer: { name: 'Winslow Hart', email: 'winslow@harborventures.example' },
  description: '',
  startsAt: '2026-09-21T21:00:00.000Z',
};

describe('prep context gathering', () => {
  let dir: string;
  let dbPath: string;
  let sessionsDir: string;
  let meetingsDir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'prep-test-'));
    dbPath = join(dir, 'cxmail.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL);
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY, account_id TEXT, folder_name TEXT, uid INTEGER,
        message_id TEXT, subject TEXT, from_name TEXT, from_email TEXT,
        to_list TEXT, cc_list TEXT, date TEXT, snippet TEXT, category TEXT, thread_root_id TEXT
      );
      CREATE TABLE message_bodies (account_id TEXT, folder_name TEXT, uid INTEGER, plain_text TEXT, html_body TEXT);
    `);
    db.prepare('INSERT INTO accounts VALUES (?, ?)').run('a1', 'chris@example.org');
    db.prepare('INSERT INTO accounts VALUES (?, ?)').run('a2', 'cxuser@example.com');

    const insMsg = db.prepare(`INSERT INTO messages
      (id, account_id, folder_name, uid, message_id, subject, from_name, from_email, to_list, cc_list, date, snippet, category, thread_root_id)
      VALUES (@id, @account_id, @folder_name, @uid, @message_id, @subject, @from_name, @from_email, @to_list, @cc_list, @date, @snippet, @category, @thread_root_id)`);
    const insBody = db.prepare('INSERT INTO message_bodies VALUES (?, ?, ?, ?, ?)');
    const to = (...emails: string[]) => JSON.stringify(emails.map((email) => ({ email, name: null })));
    const add = (m: Record<string, unknown>, body: string | null) => {
      const row: Record<string, any> = { account_id: 'a1', folder_name: 'INBOX', cc_list: '[]', category: 'primary', snippet: '', thread_root_id: '<intro>', ...m };
      insMsg.run(row);
      insBody.run(row.account_id, row.folder_name, row.uid, body, null);
    };

    add({ id: 1, uid: 1, message_id: '<intro>', subject: 'Chris <> Winslow Intro', from_name: 'Jordan Lee',
      from_email: 'jordan.lee@example.com', to_list: to('chris@example.org', 'winslow@harborventures.example'),
      date: '2026-09-10T19:00:08+00:00' },
      'Hi both,\n\n@Chris - Winslow is VP of Applied AI at Juniper Health.\n\nJordan');
    add({ id: 2, uid: 2, message_id: '<reply>', subject: 'Re: Chris <> Winslow Intro', from_name: 'Winslow Hart',
      from_email: 'winslow@harborventures.example', to_list: to('chris@example.org', 'bot@blockit.com'),
      date: '2026-09-14T12:23:46+00:00' },
      'Look forward to connecting Chris!\n\nOn Wed, Sep 10, 2026 at 3:00 PM Jordan Lee <\njordan.lee@example.com> wrote:\n> Hi both,\n> quoted intro');
    // The same reply, copied into a second mailbox — must appear once.
    add({ id: 3, account_id: 'a2', uid: 3, message_id: '<reply>', subject: 'Re: Chris <> Winslow Intro', from_name: 'Winslow Hart',
      from_email: 'winslow@harborventures.example', to_list: to('cxuser@example.com'), date: '2026-09-14T12:23:46+00:00' },
      'Look forward to connecting Chris!');
    add({ id: 4, uid: 4, message_id: '<bot1>', subject: 'Re: Chris <> Winslow Intro', from_name: 'Blockit',
      from_email: 'bot@blockit.com', to_list: to('chris@example.org'), date: '2026-09-14T12:31:11+00:00',
      snippet: 'Hi Chris, Happy to help! Would any of the following work for a call with Winslow?' },
      'Hi Chris,\n\nHappy to help! ... a very long scheduling email ...');
    add({ id: 5, uid: 5, message_id: '<draft>', folder_name: '[Gmail]/Drafts', subject: 'Re: Chris <> Winslow Intro',
      from_name: 'Chris', from_email: 'chris@example.org', to_list: to('winslow@harborventures.example'),
      date: '2026-09-15T16:08:28+00:00' }, 'DRAFT — never sent');
    add({ id: 6, uid: 6, message_id: '<invite>', subject: 'Invitation: Meets: Christopher (CX) / Winslow @ Mon Sep 21',
      from_name: 'Winslow Hart', from_email: 'winslow@harborventures.example', to_list: to('chris@example.org'),
      date: '2026-09-15T16:23:41+00:00', thread_root_id: '<invite>' }, 'Invitation from Google Calendar');
    // Unrelated mail — must not appear.
    add({ id: 7, uid: 7, message_id: '<other>', subject: 'Lunch?', from_name: 'Sam', from_email: 'sam@example.com',
      to_list: to('chris@example.org'), date: '2026-09-12T10:00:00+00:00', thread_root_id: '<other>' }, 'Lunch?');
    // Mail FROM a typed attendee, so their address can be learned from their name.
    add({ id: 8, uid: 8, message_id: '<marcus>', subject: 'Portal', from_name: 'Marcus Reed',
      from_email: 'marcus@globex.example', to_list: to('chris@example.org'), date: '2026-08-01T10:00:00+00:00',
      thread_root_id: '<marcus>' }, 'Portal feedback attached.');
    db.close();

    // A past Meeting Copilot session whose typed attendees name Winslow.
    sessionsDir = join(dir, 'sessions');
    mkdirSync(join(sessionsDir, 's1'), { recursive: true });
    const sdb = new Database(join(sessionsDir, 's1', 'session.db'));
    sdb.exec(`CREATE TABLE session (title TEXT, attendees TEXT, startedAt INTEGER);
      CREATE TABLE action (type TEXT, state TEXT, result TEXT, completedAt INTEGER);`);
    sdb.prepare('INSERT INTO session VALUES (?, ?, ?)').run('Coffee chat', 'Chris, Winslow', Date.parse('2026-08-01T15:00:00Z'));
    sdb.prepare('INSERT INTO action VALUES (?, ?, ?, ?)').run('summary', 'completed',
      JSON.stringify({ artifacts: [{ type: 'markdown', content: 'Talked about agent deployment.' }] }), 1);
    sdb.close();
    // And one with someone else entirely.
    mkdirSync(join(sessionsDir, 's2'), { recursive: true });
    const sdb2 = new Database(join(sessionsDir, 's2', 'session.db'));
    sdb2.exec('CREATE TABLE session (title TEXT, attendees TEXT, startedAt INTEGER); CREATE TABLE action (type TEXT, state TEXT, result TEXT, completedAt INTEGER);');
    sdb2.prepare('INSERT INTO session VALUES (?, ?, ?)').run('Globex Sync', 'Chris, Marcus', 1);
    sdb2.close();

    meetingsDir = join(dir, 'Meetings');
    mkdirSync(meetingsDir);
    writeFileSync(join(meetingsDir, 'Intro Winslow 08.01.26.md'), '---\ntags: [meeting]\n---\nWinslow wants a build partner.');
    writeFileSync(join(meetingsDir, 'TH Alexis 09.14.26.md'), 'Unrelated.');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const gather = (req: PrepRequest = MEETING_REQUEST) =>
    gatherPrepContext(req, { cxmailDbPath: dbPath, sessionsDir, meetingsDir });

  it('excludes the user (by cxmail account) and dedupes the organizer', () => {
    const ctx = gather();
    expect(ctx.people).toEqual([
      { name: 'Winslow Hart', email: 'winslow@harborventures.example', domain: 'harborventures.example' },
    ]);
  });

  it('finds the intro thread, oldest first, without drafts, invites, copies or unrelated mail', () => {
    const subjects = gather().emails.map((e) => `${e.date.slice(0, 10)} ${e.from.split(' <')[0]}`);
    expect(subjects).toEqual(['2026-09-10 Jordan Lee', '2026-09-14 Winslow Hart', '2026-09-14 Blockit']);
  });

  it('keeps human bodies, cuts quoted replies, and collapses bots to a snippet', () => {
    const [intro, reply, bot] = gather().emails;
    expect(intro.body).toContain('VP of Applied AI at Juniper Health');
    expect(reply.body).toBe('Look forward to connecting Chris!');
    expect(bot.automated).toBe(true);
    expect(bot.body).toBe('Hi Chris, Happy to help! Would any of the following work for a call with Winslow?');
  });

  it('matches past sessions and vault notes by first name, whole word only', () => {
    const ctx = gather();
    expect(ctx.pastMeetings.map((m) => m.title)).toEqual(['Coffee chat']);
    expect(ctx.pastMeetings[0].summary).toBe('Talked about agent deployment.');
    expect(ctx.vaultNotes.map((n) => n.file)).toEqual(['Intro Winslow 08.01.26.md']);
    expect(ctx.vaultNotes[0].excerpt).toBe('Winslow wants a build partner.'); // frontmatter dropped
  });

  it('learns a typed attendee\'s address from mail they sent', () => {
    const ctx = gather({ title: 'Portal', attendees: [{ name: 'Marcus Reed', email: null }, { name: 'Chris', email: null }] });
    expect(ctx.people).toEqual([{ name: 'Marcus Reed', email: 'marcus@globex.example', domain: 'globex.example' }]);
    expect(ctx.emails.map((e) => e.subject)).toEqual(['Portal']);
  });

  it('degrades to empty when cxmail and sessions are missing', () => {
    const ctx = gatherPrepContext(MEETING_REQUEST, {
      cxmailDbPath: join(dir, 'nope.db'), sessionsDir: join(dir, 'nope'), meetingsDir: join(dir, 'nope'),
    });
    expect(ctx.emails).toEqual([]);
    expect(ctx.pastMeetings).toEqual([]);
    expect(ctx.people).toHaveLength(2); // no account list → the self attendee can't be recognized by email
  });

  it('renders the context with the email thread and the invite', () => {
    const text = formatPrepContext(gather());
    expect(text).toContain('<meeting>');
    expect(text).toContain('Winslow Hart <winslow@harborventures.example> — company domain harborventures.example');
    expect(text).toContain('<email_history count="3" order="oldest first">');
    expect(text).toContain('(automated)');
    expect(text).toContain('<past_meetings>');
    expect(text).not.toContain('DRAFT');
  });
});

describe('stripQuotedReply', () => {
  it('cuts at a Gmail "On … wrote:" line, including the two-line form', () => {
    expect(stripQuotedReply('Sounds good\n\nOn Tue, Sep 15, 2026 at 10:24 AM Winslow <w@x.com> wrote:\n> old')).toBe('Sounds good');
    expect(stripQuotedReply('Sounds good\nOn Tue, Sep 15, 2026 at 10:24 AM Winslow Hart <\nwinslow@harborventures.example> wrote:\n> old')).toBe('Sounds good');
  });

  it('cuts at scheduling-bot and forwarded headers, and drops ">" lines', () => {
    expect(stripQuotedReply('Monday works!\nBlockit wrote on 9/15/2026, 11:03:27 AM:\nold')).toBe('Monday works!');
    expect(stripQuotedReply('FYI\n---------- Forwarded message ---------\nFrom: x')).toBe('FYI');
    expect(stripQuotedReply('New text\n> quoted\nmore')).toBe('New text\nmore');
  });
});

describe('prepRequestFromBody', () => {
  it('uses calendar attendees with emails and adds typed names it lacks', () => {
    const req = prepRequestFromBody({
      title: 'Intro',
      attendees: 'Winslow Hart, chris, Jordan Lee',
      notes: ' ask about pricing ',
      meeting: {
        title: 'Calendar title',
        attendees: [{ name: 'Winslow Hart', email: 'winslow@harborventures.example' }, { name: 'chris', email: 'chris@example.org' }],
        organizerName: 'Winslow Hart', organizerEmail: 'winslow@harborventures.example',
        description: 'Agenda: intro', startsAt: '2026-09-21T21:00:00.000Z',
      },
    });
    expect(req).not.toBeNull();
    expect(req!.title).toBe('Intro');
    expect(req!.attendees).toEqual([
      { name: 'Winslow Hart', email: 'winslow@harborventures.example' },
      { name: 'chris', email: 'chris@example.org' },
      { name: 'Jordan Lee', email: null },
    ]);
    expect(req!.organizer).toEqual({ name: 'Winslow Hart', email: 'winslow@harborventures.example' });
    expect(req!.notes).toBe('ask about pricing');
    expect(req!.description).toBe('Agenda: intro');
  });

  it('returns null when there is nothing to prep from', () => {
    expect(prepRequestFromBody({})).toBeNull();
    expect(prepRequestFromBody({ title: '  ', attendees: '', notes: '' })).toBeNull();
    expect(prepRequestFromBody(null)).toBeNull();
    expect(prepRequestFromBody({ attendees: 'Sam' })).not.toBeNull();
  });
});

const GOOD_REPLY = `Here you go.
<brief>
### Who they are
- **Winslow Hart**, VP Applied AI at Juniper Health
</brief>
<agenda>
- How do you know Jordan?
1. What does Applied AI at Juniper cover
- How do you know Jordan?
</agenda>
<sources>
- [Harbor Ventures](https://harborventures.example)
- The 74 — https://www.the74million.org/article/x
- not a link
</sources>`;

describe('parsePrepResponse', () => {
  it('reads the tagged sections, normalizes items like the notes extractor, and dedupes', () => {
    const r = parsePrepResponse(GOOD_REPLY)!;
    expect(r.brief).toContain('VP Applied AI');
    // Trailing punctuation goes, as in extractAgendaItemsFromNotes.
    expect(r.agenda).toEqual(['How do you know Jordan', 'What does Applied AI at Juniper cover']);
    expect(r.sources).toEqual([
      { title: 'Harbor Ventures', url: 'https://harborventures.example' },
      { title: 'The 74', url: 'https://www.the74million.org/article/x' },
    ]);
  });

  it('returns null for a reply with neither brief nor agenda', () => {
    expect(parsePrepResponse('Let me search for that…')).toBeNull();
    expect(parsePrepResponse('')).toBeNull();
  });
});

describe('describeToolUse', () => {
  it('names searches and the host being read', () => {
    expect(describeToolUse('WebSearch', { query: 'Juniper Health' })).toBe('Searching: Juniper Health');
    expect(describeToolUse('WebFetch', { url: 'https://www.harborventures.example/about' })).toBe('Reading harborventures.example');
    expect(describeToolUse('Bash', {})).toBeNull();
  });
});

describe('runMeetingPrep', () => {
  const emptyContext = (request: PrepRequest) => ({ request, people: [], emails: [], pastMeetings: [], vaultNotes: [] });

  it('returns the researched result and reports each tool call as progress', async () => {
    const progress: string[] = [];
    const calls: (string[] | undefined)[] = [];
    const result = await runMeetingPrep(MEETING_REQUEST, {
      gather: emptyContext,
      onProgress: (m) => progress.push(m),
      suggest: (async (_p: string, _s: string, _sig: AbortSignal | undefined, tools?: string[], opts?: any) => {
        calls.push(tools);
        opts?.onToolUse?.('WebSearch', { query: 'Winslow Hart Juniper Health' });
        return GOOD_REPLY;
      }) as any,
    });
    expect(result.mode).toBe('web');
    expect(result.agenda).toHaveLength(2);
    expect(calls).toEqual([['WebSearch', 'WebFetch']]);
    expect(progress).toContain('Searching: Winslow Hart Juniper Health');
  });

  it('falls back to a tool-less local pass when web research fails', async () => {
    const calls: (string[] | undefined)[] = [];
    const result = await runMeetingPrep(MEETING_REQUEST, {
      gather: emptyContext,
      suggest: (async (_p: string, _s: string, _sig: AbortSignal | undefined, tools?: string[]) => {
        calls.push(tools);
        if (tools) throw new Error('claude CLI exited with code 1');
        return GOOD_REPLY;
      }) as any,
    });
    expect(result.mode).toBe('local');
    expect(result.sources).toEqual([]);
    expect(calls).toEqual([['WebSearch', 'WebFetch'], undefined]);
  });

  it('falls back when the web pass returns something unparseable', async () => {
    const result = await runMeetingPrep(MEETING_REQUEST, {
      gather: emptyContext,
      suggest: (async (_p: string, _s: string, _sig: AbortSignal | undefined, tools?: string[]) =>
        tools ? 'I searched but ran out of turns' : GOOD_REPLY) as any,
    });
    expect(result.mode).toBe('local');
  });

  it('falls back when web research runs past its time limit', async () => {
    const result = await runMeetingPrep(MEETING_REQUEST, {
      gather: emptyContext,
      webTimeoutMs: 20,
      suggest: ((_p: string, _s: string, signal: AbortSignal | undefined, tools?: string[]) =>
        tools
          ? new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('Aborted'))))
          : Promise.resolve(GOOD_REPLY)) as any,
    });
    expect(result.mode).toBe('local');
  });

  it('stops without a fallback when the user cancels', async () => {
    const ctl = new AbortController();
    const calls: (string[] | undefined)[] = [];
    const run = runMeetingPrep(MEETING_REQUEST, {
      gather: emptyContext,
      signal: ctl.signal,
      suggest: ((_p: string, _s: string, signal: AbortSignal | undefined, tools?: string[]) => {
        calls.push(tools);
        return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('Aborted'))));
      }) as any,
    });
    ctl.abort();
    await expect(run).rejects.toThrow('Aborted');
    expect(calls).toEqual([['WebSearch', 'WebFetch']]);
  });

  it('throws when even the local pass is unreadable', async () => {
    await expect(
      runMeetingPrep(MEETING_REQUEST, { gather: emptyContext, suggest: (async () => 'nope') as any }),
    ).rejects.toThrow('unreadable');
  });
});
