// Upcoming-meeting lookup backed by cxmail's local SQLite database.
//
// cxmail (~/Projects/cxmail) parses calendar invites (ICS attachments) out of
// email across all of the user's accounts into a `calendar_events` table. We
// read that DB read-only — no OAuth, no API spend, no new consent surface.
// The feature degrades to an empty list on ANY failure (missing DB, schema
// drift, WAL lock) so the start form never breaks because of it.
//
// Coverage caveat: only events that arrived as email invites exist here.
// Self-created calendar events with no invite email will not appear.

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface MeetingAttendee {
  name: string;
  email: string;
}

export interface UpcomingMeeting {
  eventUid: string | null;
  title: string;
  description: string;
  location: string | null;
  meetLink: string | null;
  startsAt: string; // ISO 8601 UTC
  endsAt: string | null;
  organizerName: string | null;
  organizerEmail: string | null;
  attendees: MeetingAttendee[];
  /** Mailboxes that received this invite (the same invite lands in several). */
  accounts: string[];
}

export interface UpcomingOptions {
  dbPath?: string;
  now?: Date;
  /** How far ahead to look. Default 12h. */
  windowMs?: number;
  /** Include meetings that started up to this long ago. Default 15min. */
  lookbackMs?: number;
  limit?: number;
}

const DEFAULT_WINDOW_MS = 12 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 15 * 60 * 1000;
const DEFAULT_LIMIT = 5;

export function defaultCxmailDbPath(): string {
  return (
    process.env.CXMAIL_DB_PATH ||
    join(homedir(), 'Library', 'Application Support', 'com.cxmail.app', 'cxmail.db')
  );
}

interface EventRow {
  event_uid: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  dtstart: string;
  dtend: string | null;
  organizer_name: string | null;
  organizer_email: string | null;
  status: string | null;
  method: string | null;
  raw_ics: string | null;
  created_at: string;
  account_email: string;
}

let warnedOnce = false;

export function getUpcomingMeetings(opts: UpcomingOptions = {}): UpcomingMeeting[] {
  const dbPath = opts.dbPath ?? defaultCxmailDbPath();
  if (!existsSync(dbPath)) return [];

  const now = opts.now ?? new Date();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const lookbackMs = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  let rows: EventRow[];
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // dtstart is TEXT in mixed formats (UTC "Z", or naive wall time in the
    // event's TZID). SQLite's datetime() treats naive as UTC, which is within
    // ±14h of the truth — so prefilter generously and resolve precisely in JS.
    rows = db
      .prepare(
        `SELECT ce.event_uid, ce.summary, ce.description, ce.location,
                ce.dtstart, ce.dtend, ce.organizer_name, ce.organizer_email,
                ce.status, ce.method, ce.raw_ics, ce.created_at,
                a.email AS account_email
           FROM calendar_events ce
           JOIN accounts a ON a.id = ce.account_id
          WHERE ce.dismissed = 0
            AND (ce.source IS NULL OR ce.source = 'ics')
            AND datetime(ce.dtstart) >= datetime(?, '-1 day')
            AND datetime(ce.dtstart) <= datetime(?, '+2 day')`
      )
      .all(now.toISOString(), now.toISOString()) as EventRow[];
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(`[Calendar] cxmail DB unreadable (${dbPath}): ${err instanceof Error ? err.message : err}`);
    }
    return [];
  } finally {
    try { db?.close(); } catch {}
  }

  // Resolve times, drop cancellations/all-day, then dedupe by event UID.
  interface Resolved { row: EventRow; startMs: number; endMs: number | null }
  const resolved: Resolved[] = [];
  for (const row of rows) {
    const status = (row.status || '').toUpperCase();
    const method = (row.method || '').toUpperCase();
    if (status === 'CANCELLED' || method === 'CANCEL') continue;
    if (!row.dtstart.includes('T')) continue; // date-only = all-day, not a meeting
    const startMs = resolveEventTime(row.dtstart, row.raw_ics, 'DTSTART');
    if (startMs === null) continue;
    const endMs = row.dtend ? resolveEventTime(row.dtend, row.raw_ics, 'DTEND') : null;
    resolved.push({ row, startMs, endMs });
  }

  // Same invite arrives in multiple mailboxes (same event_uid), reschedules
  // re-send with the same UID, and attendee RSVPs come back as METHOD:REPLY
  // rows (often the ONLY trace of meetings the user organized himself) —
  // latest created_at is the current truth, attendees union across all rows
  // (a REPLY only lists the person who responded).
  const byUid = new Map<string, { best: Resolved; all: Resolved[]; accounts: Set<string> }>();
  for (const r of resolved) {
    const key = r.row.event_uid || `${r.row.summary}|${Math.floor(r.startMs / 60000)}`;
    const existing = byUid.get(key);
    if (!existing) {
      byUid.set(key, { best: r, all: [r], accounts: new Set([r.row.account_email]) });
    } else {
      existing.all.push(r);
      existing.accounts.add(r.row.account_email);
      if (r.row.created_at > existing.best.row.created_at) existing.best = r;
    }
  }

  const nowMs = now.getTime();
  const out: UpcomingMeeting[] = [];
  for (const { best, all, accounts } of byUid.values()) {
    if (best.startMs < nowMs - lookbackMs || best.startMs > nowMs + windowMs) continue;
    // The newest row wins for time/title (reschedules), but RSVP replies
    // carry no description/location/conference — fall back per-field to the
    // newest row that HAS the value.
    const newestFirst = [...all].sort((a, b) => b.row.created_at.localeCompare(a.row.created_at));
    const pick = <T>(get: (r: EventRow) => T | null | undefined): T | null => {
      for (const r of newestFirst) {
        const v = get(r.row);
        if (v !== null && v !== undefined && v !== '') return v;
      }
      return null;
    };
    // cxmail's `description` column holds only the first physical ICS line,
    // still escaped — read the full property out of the raw invite first.
    const description = pick((r) => icsDescription(unfoldIcs(r.raw_ics || ''))) || pick((r) => r.description) || '';
    const location = pick((r) => r.location);
    const attendees: MeetingAttendee[] = [];
    const seenEmails = new Set<string>();
    for (const r of all) {
      for (const a of parseAttendees(unfoldIcs(r.row.raw_ics || ''))) {
        if (seenEmails.has(a.email.toLowerCase())) continue;
        seenEmails.add(a.email.toLowerCase());
        attendees.push(a);
      }
    }
    let meetLink: string | null = null;
    for (const r of newestFirst) {
      meetLink = extractMeetLink(unfoldIcs(r.row.raw_ics || ''), r.row.location, r.row.description);
      if (meetLink) break;
    }
    out.push({
      eventUid: best.row.event_uid,
      title: cleanTitle(best.row.summary),
      description: cleanDescription(description),
      location,
      meetLink,
      startsAt: new Date(best.startMs).toISOString(),
      endsAt: best.endMs !== null ? new Date(best.endMs).toISOString() : null,
      organizerName: pick((r) => r.organizer_name),
      organizerEmail: pick((r) => r.organizer_email),
      attendees,
      accounts: [...accounts].sort(),
    });
  }
  out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return out.slice(0, limit);
}

// ─── Time resolution ────────────────────────────────────────────────────────

/**
 * cxmail stores dtstart/dtend as either UTC ("2026-07-17T14:30:00Z") or the
 * event's naive wall time ("2026-07-17T09:30:00", zone only in the raw ICS
 * as DTSTART;TZID=America/Chicago:...). Resolve both to epoch ms.
 */
export function resolveEventTime(
  value: string,
  rawIcs: string | null,
  prop: 'DTSTART' | 'DTEND'
): number | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z?)/);
  if (!m) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const [, y, mo, d, h, mi, s, z] = m;
  const wall = [Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s)] as const;
  if (z === 'Z') return Date.UTC(wall[0], wall[1] - 1, wall[2], wall[3], wall[4], wall[5]);

  const tzid = rawIcs ? extractTzid(unfoldIcs(rawIcs), prop) : null;
  if (tzid) {
    const converted = zonedWallTimeToUtc(wall, tzid);
    if (converted !== null) return converted;
  }
  // No zone info — best effort: treat as machine-local wall time.
  return new Date(wall[0], wall[1] - 1, wall[2], wall[3], wall[4], wall[5]).getTime();
}

function extractTzid(unfoldedIcs: string, prop: 'DTSTART' | 'DTEND'): string | null {
  const line = unfoldedIcs.match(new RegExp(`^${prop}([^:]*):`, 'm'));
  if (!line) return null;
  const tz = line[1].match(/TZID=([^;:]+)/);
  return tz ? tz[1].trim() : null;
}

/** Convert a wall-clock time in an IANA zone to epoch ms (two-pass for DST). */
function zonedWallTimeToUtc(
  wall: readonly [number, number, number, number, number, number],
  timeZone: string
): number | null {
  try {
    const wantedUtc = Date.UTC(wall[0], wall[1] - 1, wall[2], wall[3], wall[4], wall[5]);
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
    let ts = wantedUtc;
    for (let i = 0; i < 2; i++) {
      const parts: Record<string, number> = {};
      for (const p of dtf.formatToParts(ts)) {
        if (p.type !== 'literal') parts[p.type] = Number(p.value);
      }
      const rendered = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
      ts += wantedUtc - rendered;
      if (rendered === wantedUtc) break;
    }
    return ts;
  } catch {
    return null; // unknown TZID
  }
}

// ─── ICS parsing ────────────────────────────────────────────────────────────

/** RFC 5545 line unfolding: a CRLF followed by whitespace continues the line. */
export function unfoldIcs(ics: string): string {
  return ics.replace(/\r?\n[ \t]/g, '');
}

export function parseAttendees(unfoldedIcs: string): MeetingAttendee[] {
  const out: MeetingAttendee[] = [];
  const seen = new Set<string>();
  const lines = unfoldedIcs.match(/^ATTENDEE[^\r\n]*/gm) || [];
  for (const line of lines) {
    if (/CUTYPE=(RESOURCE|ROOM)/i.test(line)) continue; // conference rooms
    const email = (line.match(/:mailto:([^\s]+)$/i) || [])[1];
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    const cn = (line.match(/;CN=("[^"]*"|[^;:]*)/) || [])[1];
    const name = cn ? cn.replace(/^"|"$/g, '').trim() : '';
    out.push({ name: name && name !== email ? name : email.split('@')[0], email });
  }
  return out;
}

function extractMeetLink(
  unfoldedIcs: string,
  location: string | null,
  description: string | null
): string | null {
  const conf = unfoldedIcs.match(/^X-GOOGLE-CONFERENCE:(\S+)/m);
  if (conf) return conf[1];
  const linkRe = /https:\/\/[^\s<>"]*(meet\.google\.com|zoom\.us\/j|teams\.microsoft\.com)[^\s<>"]*/;
  for (const source of [location, description]) {
    const m = source && source.match(linkRe);
    if (m) return m[0];
  }
  return null;
}

/** Strip RSVP-reply prefixes Google puts on METHOD:REPLY summaries. */
export function cleanTitle(summary: string | null): string {
  const t = (summary || '').trim();
  const cleaned = t.replace(/^(Accepted|Declined|Tentatively accepted|Tentative|Updated invitation)\s*:\s*/i, '').trim();
  return cleaned || 'Untitled meeting';
}

/**
 * The event's own DESCRIPTION from an unfolded ICS, still ICS-escaped (the
 * same form as cxmail's column — cleanDescription unescapes both). VALARM
 * blocks are dropped first: their DESCRIPTION ("This is an event reminder")
 * would otherwise stand in for an event that has none.
 */
export function icsDescription(unfoldedIcs: string): string | null {
  const withoutAlarms = unfoldedIcs.replace(/^BEGIN:VALARM[\s\S]*?^END:VALARM\r?$/gm, '');
  const m = withoutAlarms.match(/^DESCRIPTION(?:;[^:\r\n]*)?:(.*)$/m);
  if (!m) return null;
  const value = m[1].replace(/\r$/, '').trim();
  return value || null;
}

/** RFC 5545 TEXT unescaping: \\n, \\, \\; and \\\\. */
export function unescapeIcsText(text: string): string {
  return text.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Invites are often HTML (Google, Outlook, scheduling bots). Keep the words. */
function htmlToText(text: string): string {
  // `$` too: cxmail's truncated column can end inside an unclosed tag.
  if (!/<[a-z!/][^>]*(>|$)/i.test(text)) return text;
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, '').trim();
      return label || href;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/<[a-z!/][^>]*$/i, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Footers scheduling tools append to every invite they send. Deliberately
// narrow: a whole line must match, so a real agenda line mentioning a tool
// survives.
const SCHEDULER_FOOTER_LINES = [
  /^_{5,}$/,                                                      // "____________________" rule
  /^(sent|scheduled|booked|powered) (via|with|by|using)( [\w .-]{1,40})?[^\w]*$/i, // "Sent via Blockit AI ⚡️"
];

/**
 * Turn a raw invite description into readable notes: unescape ICS text, drop
 * HTML, strip Google Calendar's "-::~:~:: ... ::~:~::-" block and scheduling
 * tool footers. An invite that is only boilerplate comes back empty.
 */
export function cleanDescription(description: string): string {
  description = htmlToText(unescapeIcsText(description));
  const marker = /-::~[:~]*::-/g;
  const markers = [...description.matchAll(marker)];
  let cleaned = description;
  if (markers.length >= 2) {
    const first = markers[0].index!;
    const last = markers[markers.length - 1];
    cleaned = description.slice(0, first) + description.slice(last.index! + last[0].length);
  }
  // cxmail sometimes stores only the first physical ICS line, leaving a
  // truncated marker with no "::-" terminator — drop any line that is
  // nothing but marker characters.
  cleaned = cleaned
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => {
      const bare = line.replace(/\s/g, '');
      if (bare && /^[-:~]+$/.test(bare)) return false;
      const trimmed = line.trim();
      return !SCHEDULER_FOOTER_LINES.some((re) => re.test(trimmed));
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > 2000 ? cleaned.slice(0, 2000) + '…' : cleaned;
}
