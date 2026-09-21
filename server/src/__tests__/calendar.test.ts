import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getUpcomingMeetings,
  parseAttendees,
  unfoldIcs,
  cleanTitle,
  cleanDescription,
  icsDescription,
  resolveEventTime,
} from '../calendar/cxmail.js';

// Frozen "now" for deterministic windows: July 17 2026, noon UTC (CDT = UTC-5).
const NOW = new Date('2026-07-17T12:00:00Z');

const REQUEST_ICS = [
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'DTSTART;TZID=America/Chicago:20260717T093000',
  'DTEND;TZID=America/Chicago:20260717T100000',
  // Folded line (continuation starts with a space) — must unfold to parse.
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=',
  ' TRUE;CN=chris@example.org;X-NUM-GUESTS=0:mailto:chris@example.org',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE',
  ' ;CN=Owen Mercer;X-NUM-GUESTS=0:mailto:owen@brightline.example',
  'ATTENDEE;CUTYPE=RESOURCE;CN=Conf Room 4:mailto:room4@example.com',
  'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const REPLY_ICS = [
  'BEGIN:VCALENDAR',
  'METHOD:REPLY',
  'BEGIN:VEVENT',
  'DTSTART:20260717T143000Z',
  'ATTENDEE;PARTSTAT=ACCEPTED;CN=Rory Hale:mailto:rory@northwind.example',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('cxmail calendar', () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cal-test-'));
    dbPath = join(dir, 'cxmail.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL);
      CREATE TABLE calendar_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        event_uid TEXT, summary TEXT, description TEXT, location TEXT,
        dtstart TEXT NOT NULL, dtend TEXT,
        organizer_name TEXT, organizer_email TEXT,
        status TEXT, method TEXT, raw_ics TEXT,
        source TEXT NOT NULL DEFAULT 'ics',
        dismissed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
    db.prepare(`INSERT INTO accounts (id, email) VALUES (?, ?)`).run('a1', 'chris@example.org');
    db.prepare(`INSERT INTO accounts (id, email) VALUES (?, ?)`).run('a2', 'cxuser@example.com');

    const ins = db.prepare(`
      INSERT INTO calendar_events
        (account_id, event_uid, summary, description, location, dtstart, dtend,
         organizer_name, organizer_email, status, method, raw_ics, source, dismissed, created_at)
      VALUES (@account_id, @event_uid, @summary, @description, @location, @dtstart, @dtend,
              @organizer_name, @organizer_email, @status, @method, @raw_ics, @source, @dismissed, @created_at)
    `);
    const base = {
      description: null, location: null, dtend: null,
      organizer_name: null, organizer_email: null,
      status: 'CONFIRMED', method: 'REQUEST', raw_ics: null,
      source: 'ics', dismissed: 0,
    };

    // Same meeting, two mailboxes: naive-TZID REQUEST + a later UTC REPLY.
    ins.run({ ...base, account_id: 'a1', event_uid: 'uid-sync', summary: 'Northwind Sync',
      description: 'Agenda:\n- pilot scope\n- pricing',
      dtstart: '2026-07-17T09:30:00', dtend: '2026-07-17T10:00:00',
      raw_ics: REQUEST_ICS, created_at: '2026-07-10 08:00:00' });
    ins.run({ ...base, account_id: 'a2', event_uid: 'uid-sync', summary: 'Accepted: Northwind Sync',
      method: 'REPLY', dtstart: '2026-07-17T14:30:00Z',
      raw_ics: REPLY_ICS, created_at: '2026-07-11 09:00:00' });

    // Plain UTC event later the same day.
    ins.run({ ...base, account_id: 'a1', event_uid: 'uid-remi', summary: 'Chris | Remi 1:1',
      dtstart: '2026-07-17T22:00:00Z', created_at: '2026-07-01 00:00:00' });

    // Excluded: cancelled, dismissed, all-day, past, beyond window, llm-extracted.
    ins.run({ ...base, account_id: 'a1', event_uid: 'uid-cancelled', summary: 'Cancelled mtg',
      status: 'CANCELLED', dtstart: '2026-07-17T15:00:00Z', created_at: '2026-07-01 00:00:00' });
    ins.run({ ...base, account_id: 'a1', event_uid: 'uid-dismissed', summary: 'Dismissed mtg',
      dismissed: 1, dtstart: '2026-07-17T16:00:00Z', created_at: '2026-07-01 00:00:00' });
    ins.run({ ...base, account_id: 'a1', event_uid: 'uid-allday', summary: 'Holiday',
      dtstart: '2026-07-17', created_at: '2026-07-01 00:00:00' });
    ins.run({ ...base, account_id: 'a1', event_uid: 'uid-past', summary: 'Earlier today',
      dtstart: '2026-07-17T10:00:00Z', created_at: '2026-07-01 00:00:00' });
    ins.run({ ...base, account_id: 'a1', event_uid: 'uid-tomorrow', summary: 'Tomorrow',
      dtstart: '2026-07-18T14:00:00Z', created_at: '2026-07-01 00:00:00' });
    ins.run({ ...base, account_id: 'a1', event_uid: 'uid-guess', summary: 'LLM guess',
      source: 'llm', dtstart: '2026-07-17T17:00:00Z', created_at: '2026-07-01 00:00:00' });
    db.close();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] for a missing DB instead of throwing', () => {
    expect(getUpcomingMeetings({ dbPath: join(dir, 'nope.db'), now: NOW })).toEqual([]);
  });

  it('returns upcoming meetings in the window, sorted, filtered', () => {
    const meetings = getUpcomingMeetings({ dbPath, now: NOW });
    expect(meetings.map((m) => m.eventUid)).toEqual(['uid-sync', 'uid-remi']);
  });

  it('resolves naive TZID wall time via raw_ics and dedupes with the UTC row', () => {
    const [sync] = getUpcomingMeetings({ dbPath, now: NOW });
    // 09:30 America/Chicago in July (CDT, UTC-5) = 14:30Z — both rows agree.
    expect(sync.startsAt).toBe('2026-07-17T14:30:00.000Z');
    expect(sync.accounts).toEqual(['chris@example.org', 'cxuser@example.com']);
  });

  it('takes the latest row as truth but cleans RSVP-reply titles', () => {
    const [sync] = getUpcomingMeetings({ dbPath, now: NOW });
    expect(sync.title).toBe('Northwind Sync'); // "Accepted: " stripped
  });

  it('unions attendees across REQUEST and REPLY rows, skipping rooms', () => {
    const [sync] = getUpcomingMeetings({ dbPath, now: NOW });
    const emails = sync.attendees.map((a) => a.email).sort();
    expect(emails).toEqual(['chris@example.org', 'owen@brightline.example', 'rory@northwind.example']);
    const sean = sync.attendees.find((a) => a.email === 'owen@brightline.example');
    expect(sean?.name).toBe('Owen Mercer');
  });

  it('extracts the meet link and keeps the description', () => {
    const [sync] = getUpcomingMeetings({ dbPath, now: NOW });
    expect(sync.meetLink).toBe('https://meet.google.com/abc-defg-hij');
    expect(sync.description).toContain('pilot scope');
  });

  it('respects lookback for just-started meetings', () => {
    const meetings = getUpcomingMeetings({ dbPath, now: NOW, lookbackMs: 3 * 60 * 60 * 1000 });
    expect(meetings.map((m) => m.eventUid)).toContain('uid-past');
  });
});

describe('ICS helpers', () => {
  it('parseAttendees unfolds folded lines and falls back to email local part', () => {
    const atts = parseAttendees(unfoldIcs(REQUEST_ICS));
    expect(atts).toHaveLength(2); // room excluded
    expect(atts[0]).toEqual({ name: 'chris', email: 'chris@example.org' });
  });

  it('cleanTitle strips reply prefixes only', () => {
    expect(cleanTitle('Accepted: Weekly Sync')).toBe('Weekly Sync');
    expect(cleanTitle('Declined: Weekly Sync')).toBe('Weekly Sync');
    expect(cleanTitle('Budget: Q3 review')).toBe('Budget: Q3 review');
    expect(cleanTitle(null)).toBe('Untitled meeting');
  });

  it('cleanDescription strips the Google Calendar boilerplate block', () => {
    const desc = 'Prep notes here\n\n-::~:~::~:~:~::-\nJoin with Google Meet: https://x\n-::~:~::~:~:~::-';
    expect(cleanDescription(desc)).toBe('Prep notes here');
  });

  it('cleanDescription drops truncated marker-only lines', () => {
    // cxmail sometimes stores only the first physical ICS line of the marker.
    expect(cleanDescription('-::~:~::~:~:~:~:~:~:~:~:~:~')).toBe('');
    expect(cleanDescription('Real agenda\n-::~:~::~:~')).toBe('Real agenda');
  });

  // The 2026-09-21 Winslow invite, byte for byte: a Blockit footer plus the
  // Google Meet block, folded mid-URL. The start form showed the first
  // physical line raw — literal "\n" and a cut-off <a> tag.
  const BLOCKIT_ICS = [
    'BEGIN:VEVENT',
    'DESCRIPTION:\\n____________________\\nSent via <a href="https://www.blockit.c',
    ' om">Blockit AI</a> ⚡️\\n\\n-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:',
    ' ~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-\\nJoin with Google Meet: https://meet.',
    ' google.com/xyz-abcd-efg\\nOr dial: (US) +1 555-010-0199 PIN: 000000000#\\n',
    ' \\nPlease do not edit this section.\\n-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~',
    ' :~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-',
    'LOCATION:https://meet.google.com/xyz-abcd-efg',
    'END:VEVENT',
  ].join('\r\n');

  it('icsDescription reads the full folded property, not the first line', () => {
    const raw = icsDescription(unfoldIcs(BLOCKIT_ICS));
    expect(raw).toContain('Blockit AI</a>');
    expect(raw).toContain('Please do not edit this section.');
  });

  it('a scheduling-bot invite with only boilerplate cleans to empty', () => {
    expect(cleanDescription(icsDescription(unfoldIcs(BLOCKIT_ICS))!)).toBe('');
    // The truncated first line cxmail stores in its column cleans to empty too.
    expect(cleanDescription('\\n____________________\\nSent via <a href="https://www.blockit.c')).toBe('');
  });

  it('cleanDescription unescapes ICS text and keeps a real agenda', () => {
    const desc = 'Agenda:\\n- pilot scope\\, timeline\\n- pricing\\; terms\\n\\n-::~:~::-\\nJoin with Google Meet\\n-::~:~::-';
    expect(cleanDescription(desc)).toBe('Agenda:\n- pilot scope, timeline\n- pricing; terms');
  });

  it('cleanDescription turns HTML into text and keeps link labels', () => {
    const html = '<p>Topics:</p><ul><li>Q3 <b>roadmap</b></li><li>See <a href="https://x.co/doc">the brief</a></li></ul>&amp; more';
    expect(cleanDescription(html)).toBe('Topics:\n- Q3 roadmap\n- See the brief\n& more');
  });

  it('keeps an agenda line that merely mentions a scheduling tool', () => {
    expect(cleanDescription('Sent via Blockit: discuss how we book demos')).toBe(
      'Sent via Blockit: discuss how we book demos',
    );
  });

  it('icsDescription ignores a VALARM reminder when the event has no description', () => {
    const ics = 'BEGIN:VEVENT\r\nSUMMARY:x\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:This is an event reminder\r\nEND:VALARM\r\nEND:VEVENT';
    expect(icsDescription(unfoldIcs(ics))).toBeNull();
  });

  it('resolveEventTime handles UTC, TZID, and garbage', () => {
    expect(resolveEventTime('2026-07-17T14:30:00Z', null, 'DTSTART')).toBe(
      Date.parse('2026-07-17T14:30:00Z')
    );
    expect(
      resolveEventTime('2026-07-17T09:30:00', REQUEST_ICS, 'DTSTART')
    ).toBe(Date.parse('2026-07-17T14:30:00Z'));
    expect(resolveEventTime('not a date', null, 'DTSTART')).toBeNull();
  });
});
