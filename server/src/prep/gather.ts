// Meeting prep, step 1: everything the user's own records already say about a
// meeting — the invite, email threads with the other attendees, past Meeting
// Copilot sessions with them, and vault meeting notes that name them.
//
// Deterministic, local, read-only, no model and no network: this runs before
// the prep agent (prep/agent.ts) so the agent starts from what the user
// already knows instead of rediscovering it. Every source degrades to empty
// on any failure — prep must never break because cxmail or a session DB is
// missing or locked.

import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { defaultCxmailDbPath } from '../calendar/cxmail.js';

export interface PrepAttendee {
  name: string;
  email: string | null;
}

export interface PrepRequest {
  title: string;
  attendees: PrepAttendee[];
  organizer?: PrepAttendee | null;
  /** Cleaned invite description (calendar/cxmail.ts cleanDescription). */
  description?: string;
  /** Whatever the user typed in the agenda box. */
  notes?: string;
  startsAt?: string | null;
}

export interface PrepPerson {
  name: string;
  email: string | null;
  /** Company email domain — null for gmail/icloud/etc. */
  domain: string | null;
}

export interface PrepEmail {
  date: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  /** Scheduling bots, no-reply senders — body is a one-line snippet. */
  automated: boolean;
}

export interface PrepPastMeeting {
  title: string;
  date: string;
  attendees: string;
  summary: string;
}

export interface PrepVaultNote {
  file: string;
  excerpt: string;
}

export interface PrepContext {
  request: PrepRequest;
  /** The other side — the user is excluded. */
  people: PrepPerson[];
  /** Oldest first, so the thread reads as the story of how this meeting came about. */
  emails: PrepEmail[];
  pastMeetings: PrepPastMeeting[];
  vaultNotes: PrepVaultNote[];
}

export interface GatherOptions {
  cxmailDbPath?: string;
  sessionsDir?: string;
  meetingsDir?: string;
  /** Addresses that are the user. cxmail's own account list is always added. */
  selfEmails?: string[];
  selfNames?: string[];
}

const DEFAULT_SELF_NAMES = ['chris', 'christopher', 'chris robinson', 'christopher robinson', 'cx'];

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
]);

const AUTOMATED_SENDER = /(^|[._+-])(bot|noreply|no-reply|donotreply|do-not-reply|notifications?|calendar-notification|mailer-daemon)@|@(blockit\.com|calendly\.com|calendar\.google\.com)$/i;
const CALENDAR_SUBJECT = /^(invitation|updated invitation|accepted|declined|tentatively accepted|canceled event|cancelled event)\b[^:]*:/i;

const EMAIL_BODY_MAX_CHARS = 1_500;
const EMAIL_TOTAL_MAX_CHARS = 10_000;
const AUTOMATED_MAX = 4;
const SUMMARY_MAX_CHARS = 1_200;
const NOTE_EXCERPT_MAX_CHARS = 1_500;
const MAX_PAST_MEETINGS = 3;
const MAX_VAULT_NOTES = 3;

export function gatherPrepContext(request: PrepRequest, opts: GatherOptions = {}): PrepContext {
  const dbPath = opts.cxmailDbPath ?? defaultCxmailDbPath();
  const selfEmails = new Set((opts.selfEmails ?? []).map((e) => e.toLowerCase()));
  for (const e of readCxmailAccounts(dbPath)) selfEmails.add(e);
  const selfNames = new Set((opts.selfNames ?? DEFAULT_SELF_NAMES).map((n) => n.toLowerCase()));

  const people = identifyPeople(request, selfEmails, selfNames);
  const { emails, resolved } = readEmailHistory(dbPath, people, selfEmails);
  // Typed names that the email search matched now carry an address.
  const withEmails = people.map((p) => resolved.get(p.name) ?? p);

  return {
    request,
    people: withEmails,
    emails,
    pastMeetings: readPastMeetings(opts.sessionsDir ?? join(homedir(), '.meeting-copilot', 'sessions'), withEmails, selfNames),
    vaultNotes: readVaultNotes(opts.meetingsDir ?? join(homedir(), 'Documents', 'CX', 'Meetings'), withEmails, selfNames),
  };
}

// ─── People ─────────────────────────────────────────────────────────────────

function identifyPeople(request: PrepRequest, selfEmails: Set<string>, selfNames: Set<string>): PrepPerson[] {
  const all = [...request.attendees];
  if (request.organizer) all.push(request.organizer);
  const out: PrepPerson[] = [];
  const seen = new Set<string>();
  for (const a of all) {
    const email = a.email ? a.email.trim().toLowerCase() : null;
    const name = (a.name || '').trim() || (email ? email.split('@')[0] : '');
    if (!name) continue;
    if (email && selfEmails.has(email)) continue;
    if (!email && selfNames.has(name.toLowerCase())) continue;
    const key = email ?? `name:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    // A typed name that duplicates an attendee we already have by email.
    if (!email && out.some((p) => p.name.toLowerCase() === name.toLowerCase())) continue;
    seen.add(key);
    out.push({ name, email, domain: companyDomain(email) });
  }
  return out;
}

export function companyDomain(email: string | null): string | null {
  const domain = email?.split('@')[1]?.toLowerCase();
  if (!domain || FREE_MAIL_DOMAINS.has(domain)) return null;
  return domain;
}

// ─── Email (cxmail) ─────────────────────────────────────────────────────────

interface MessageRow {
  id: number;
  message_id: string | null;
  subject: string | null;
  from_name: string | null;
  from_email: string | null;
  to_list: string | null;
  date: string;
  snippet: string | null;
  thread_root_id: string | null;
  plain_text: string | null;
  html_body: string | null;
}

const MESSAGE_COLUMNS = `m.id, m.message_id, m.subject, m.from_name, m.from_email, m.to_list,
  m.date, m.snippet, m.thread_root_id, b.plain_text, b.html_body`;
const MESSAGE_FROM = `messages m
  LEFT JOIN message_bodies b
    ON b.account_id = m.account_id AND b.folder_name = m.folder_name AND b.uid = m.uid`;
const REAL_FOLDERS = `m.folder_name NOT LIKE '%Drafts%' AND m.folder_name NOT LIKE '%Trash%'
  AND m.folder_name NOT LIKE '%Spam%' AND m.folder_name NOT LIKE '%Junk%'`;

function readCxmailAccounts(dbPath: string): string[] {
  return withDb(dbPath, [], (db) =>
    (db.prepare('SELECT email FROM accounts').all() as { email: string }[]).map((r) => r.email.toLowerCase()),
  );
}

function readEmailHistory(
  dbPath: string,
  people: PrepPerson[],
  selfEmails: Set<string>,
): { emails: PrepEmail[]; resolved: Map<string, PrepPerson> } {
  const resolved = new Map<string, PrepPerson>();
  if (people.length === 0) return { emails: [], resolved };

  return withDb(dbPath, { emails: [], resolved }, (db) => {
    // Typed attendees have no address — learn one from mail they sent.
    for (const p of people) {
      if (p.email || p.name.trim().split(/\s+/).length < 2) continue;
      const hit = db
        .prepare(`SELECT from_email FROM messages m WHERE lower(m.from_name) = ? AND ${REAL_FOLDERS}
                  ORDER BY m.date DESC LIMIT 1`)
        .get(p.name.toLowerCase()) as { from_email: string | null } | undefined;
      const email = hit?.from_email?.toLowerCase();
      if (email && !selfEmails.has(email)) resolved.set(p.name, { ...p, email, domain: companyDomain(email) });
    }
    const known = people.map((p) => resolved.get(p.name) ?? p);

    const clauses: string[] = [];
    const params: string[] = [];
    for (const p of known) {
      if (p.email) {
        clauses.push(`lower(m.from_email) = ?`, `lower(m.to_list) LIKE ?`, `lower(m.cc_list) LIKE ?`);
        params.push(p.email, `%"${p.email}"%`, `%"${p.email}"%`);
      }
      // Colleagues at the same company count, but only real correspondence —
      // a company's newsletters would drown the thread that matters.
      if (p.domain) {
        clauses.push(`(lower(m.from_email) LIKE ? AND (m.category = 'primary' OR m.category IS NULL))`);
        params.push(`%@${p.domain}`);
      }
    }
    if (clauses.length === 0) return { emails: [], resolved };

    const direct = db
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM}
                WHERE (${clauses.join(' OR ')}) AND ${REAL_FOLDERS}
                ORDER BY m.date DESC LIMIT 150`)
      .all(...params) as MessageRow[];

    // Pull in the rest of each thread: an intro can reach the user before the
    // other person ever writes.
    const roots = [...new Set(direct.map((r) => r.thread_root_id).filter((r): r is string => !!r))].slice(0, 20);
    const threadRows = roots.length
      ? (db
          .prepare(`SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM}
                    WHERE m.thread_root_id IN (${roots.map(() => '?').join(',')}) AND ${REAL_FOLDERS}
                    ORDER BY m.date DESC LIMIT 150`)
          .all(...roots) as MessageRow[])
      : [];

    return { emails: selectEmails([...direct, ...threadRows]), resolved };
  });
}

function selectEmails(rows: MessageRow[]): PrepEmail[] {
  // The same message sits in Sent in one account and INBOX in another.
  const unique = new Map<string, MessageRow>();
  for (const r of rows) {
    const key = r.message_id || `id:${r.id}`;
    if (!unique.has(key)) unique.set(key, r);
  }
  const newestFirst = [...unique.values()]
    .filter((r) => !CALENDAR_SUBJECT.test((r.subject || '').trim()))
    .sort((a, b) => b.date.localeCompare(a.date));

  const picked: PrepEmail[] = [];
  let budget = EMAIL_TOTAL_MAX_CHARS;
  let automatedCount = 0;
  for (const r of newestFirst) {
    const automated = AUTOMATED_SENDER.test(r.from_email || '');
    if (automated) {
      if (automatedCount >= AUTOMATED_MAX) continue;
      automatedCount++;
    }
    const body = automated
      ? oneLine(r.snippet || '').slice(0, 200)
      : truncate(stripQuotedReply(r.plain_text || htmlToPlain(r.html_body || '') || r.snippet || ''), EMAIL_BODY_MAX_CHARS);
    if (!automated && body.length > budget) continue;
    if (!automated) budget -= body.length;
    picked.push({
      date: r.date,
      from: r.from_name ? `${r.from_name} <${r.from_email}>` : r.from_email || 'unknown',
      to: formatRecipients(r.to_list),
      subject: (r.subject || '').trim(),
      body,
      automated,
    });
  }
  return picked.sort((a, b) => a.date.localeCompare(b.date));
}

/** Cut a reply at the point it starts quoting the message it answers. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? '';
    // "On Tue, Sep 15, 2026 at 10:24 AM Winslow Hart <w@x.com> wrote:" —
    // Gmail wraps it onto a second line when the address is long.
    if (/^On .{4,200}wrote:\s*$/.test(line) || (/^On .{4,200}$/.test(line) && /^.{0,120}wrote:\s*$/.test(next))) break;
    if (/^\S.{0,100} wrote on \d/.test(line)) break; // "Blockit wrote on 9/15/2026, 11:03 AM"
    if (/^-{2,}\s*(Original|Forwarded) Message/i.test(line)) break;
    if (/^>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

function htmlToPlain(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function formatRecipients(toList: string | null): string {
  if (!toList) return '';
  try {
    const list = JSON.parse(toList) as { email?: string; name?: string | null }[];
    return list
      .map((r) => (r.name ? `${r.name} <${r.email}>` : r.email))
      .filter(Boolean)
      .join(', ');
  } catch {
    return '';
  }
}

// ─── Past Meeting Copilot sessions ──────────────────────────────────────────

function readPastMeetings(sessionsDir: string, people: PrepPerson[], selfNames: Set<string>): PrepPastMeeting[] {
  if (people.length === 0 || !existsSync(sessionsDir)) return [];
  // Session attendees are whatever was typed — usually first names.
  const needles = personNeedles(people, selfNames, { firstNames: true });
  const found: (PrepPastMeeting & { at: number })[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(sessionsDir);
  } catch {
    return [];
  }
  for (const dir of dirs) {
    const dbPath = join(sessionsDir, dir, 'session.db');
    if (!existsSync(dbPath)) continue;
    const hit = withDb(dbPath, null, (db) => {
      const s = db.prepare('SELECT title, attendees, startedAt FROM session LIMIT 1').get() as
        | { title: string; attendees: string; startedAt: number }
        | undefined;
      if (!s) return null;
      const haystack = `${s.title} ${s.attendees}`.toLowerCase();
      if (!needles.some((n) => containsWord(haystack, n))) return null;
      const summaryRow = db
        .prepare(`SELECT result FROM action WHERE type = 'summary' AND state = 'completed'
                  ORDER BY completedAt DESC LIMIT 1`)
        .get() as { result: string | null } | undefined;
      return {
        title: s.title,
        attendees: s.attendees,
        date: new Date(s.startedAt).toISOString().slice(0, 10),
        summary: truncate(summaryText(summaryRow?.result ?? null), SUMMARY_MAX_CHARS),
        at: s.startedAt,
      };
    });
    if (hit) found.push(hit);
  }
  return found
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_PAST_MEETINGS)
    .map(({ at: _at, ...m }) => m);
}

function summaryText(result: string | null): string {
  if (!result) return '';
  try {
    const parsed = JSON.parse(result);
    const artifact = Array.isArray(parsed?.artifacts) ? parsed.artifacts.find((a: any) => typeof a?.content === 'string') : null;
    if (artifact) return artifact.content;
    if (typeof parsed?.data?.summary === 'string') return parsed.data.summary;
    if (typeof parsed?.summary === 'string') return parsed.summary;
    return '';
  } catch {
    return result;
  }
}

// ─── Vault meeting notes ────────────────────────────────────────────────────

function readVaultNotes(meetingsDir: string, people: PrepPerson[], selfNames: Set<string>): PrepVaultNote[] {
  if (people.length === 0 || !existsSync(meetingsDir)) return [];
  // Notes are filed as "<CATEGORY> <Who|Topic> <MM.DD.YY>.md", so the file
  // name alone says who a meeting was with — first names included.
  const needles = personNeedles(people, selfNames, { firstNames: true });
  const matches: { path: string; mtime: number }[] = [];
  for (const path of listMarkdown(meetingsDir, 2)) {
    const name = basename(path).toLowerCase();
    if (!needles.some((n) => containsWord(name, n))) continue;
    try {
      matches.push({ path, mtime: statSync(path).mtimeMs });
    } catch {
      // vanished between listing and stat
    }
  }
  return matches
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_VAULT_NOTES)
    .map(({ path }) => {
      let text = '';
      try {
        text = readFileSync(path, 'utf-8').replace(/^---\n[\s\S]*?\n---\n/, '');
      } catch {
        // unreadable — keep the file name, which is itself a signal
      }
      return { file: basename(path), excerpt: truncate(text.trim(), NOTE_EXCERPT_MAX_CHARS) };
    });
}

function listMarkdown(dir: string, depth: number): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...listMarkdown(full, depth - 1));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Lowercase strings that identify a person in a title, attendee list or file name. */
function personNeedles(people: PrepPerson[], selfNames: Set<string>, opts: { firstNames?: boolean } = {}): string[] {
  const out = new Set<string>();
  for (const p of people) {
    const name = p.name.toLowerCase().trim();
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) out.add(name);
    const last = parts.length >= 2 ? parts[parts.length - 1] : null;
    if (last && last.length >= 4) out.add(last);
    if (opts.firstNames && parts[0] && parts[0].length >= 4 && !selfNames.has(parts[0])) out.add(parts[0]);
    if (p.email) out.add(p.email);
    const company = p.domain?.split('.')[0];
    if (company && company.length >= 5) out.add(company);
  }
  return [...out];
}

function containsWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack);
}

function withDb<T>(dbPath: string, fallback: T, fn: (db: InstanceType<typeof Database>) => T): T {
  if (!existsSync(dbPath)) return fallback;
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return fn(db);
  } catch (err) {
    console.warn(`[Prep] ${basename(dbPath)} unreadable: ${err instanceof Error ? err.message : err}`);
    return fallback;
  } finally {
    try { db?.close(); } catch {}
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max).trimEnd() + '…' : text;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ─── Prompt rendering ───────────────────────────────────────────────────────

/** Render the gathered context as the prep agent's input. */
export function formatPrepContext(ctx: PrepContext): string {
  const r = ctx.request;
  const sections: string[] = [];

  const meeting = [`Title: ${r.title || '(untitled)'}`];
  if (r.startsAt) meeting.push(`Starts: ${r.startsAt}`);
  if (r.organizer?.name || r.organizer?.email) {
    meeting.push(`Organizer: ${r.organizer.name || ''}${r.organizer.email ? ` <${r.organizer.email}>` : ''}`.trim());
  }
  meeting.push(
    ctx.people.length
      ? `Other attendees:\n${ctx.people
          .map((p) => `- ${p.name}${p.email ? ` <${p.email}>` : ''}${p.domain ? ` — company domain ${p.domain}` : ''}`)
          .join('\n')}`
      : 'Other attendees: none listed',
  );
  if (r.description?.trim()) meeting.push(`Invite description:\n${r.description.trim()}`);
  sections.push(`<meeting>\n${meeting.join('\n')}\n</meeting>`);

  if (r.notes?.trim()) sections.push(`<chris_notes>\n${r.notes.trim()}\n</chris_notes>`);

  if (ctx.emails.length) {
    const body = ctx.emails
      .map((e) => `--- ${e.date.slice(0, 10)} · From: ${e.from}${e.to ? ` · To: ${e.to}` : ''}\nSubject: ${e.subject}${e.automated ? ' (automated)' : ''}\n${e.body}`)
      .join('\n\n');
    sections.push(`<email_history count="${ctx.emails.length}" order="oldest first">\n${body}\n</email_history>`);
  } else {
    sections.push('<email_history count="0">No email with these attendees on record.</email_history>');
  }

  if (ctx.pastMeetings.length) {
    const body = ctx.pastMeetings
      .map((m) => `--- ${m.date} · ${m.title} (attendees: ${m.attendees})\n${m.summary || '(no summary)'}`)
      .join('\n\n');
    sections.push(`<past_meetings>\n${body}\n</past_meetings>`);
  }

  if (ctx.vaultNotes.length) {
    const body = ctx.vaultNotes.map((n) => `--- ${n.file}\n${n.excerpt}`).join('\n\n');
    sections.push(`<vault_notes note="file names matched an attendee — may be a different person with the same first name">\n${body}\n</vault_notes>`);
  }

  return sections.join('\n\n');
}

// ─── Request parsing ────────────────────────────────────────────────────────

const MAX_FIELD_CHARS = 20_000;

/**
 * Build a PrepRequest from the start form's POST body:
 *   { title?, attendees?: "Winslow Hart, chris", notes?, meeting?: UpcomingMeeting }
 * `meeting` (the calendar chip the user picked) contributes attendees WITH
 * email addresses; names typed into the form that it doesn't already cover
 * are added by name. Returns null when there is nothing to prep from.
 */
export function prepRequestFromBody(body: unknown): PrepRequest | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, MAX_FIELD_CHARS) : '');
  const meeting = (b.meeting && typeof b.meeting === 'object' ? b.meeting : null) as Record<string, unknown> | null;

  const attendees: PrepAttendee[] = [];
  if (meeting && Array.isArray(meeting.attendees)) {
    for (const a of meeting.attendees as unknown[]) {
      if (!a || typeof a !== 'object') continue;
      const { name, email } = a as { name?: unknown; email?: unknown };
      const e = str(email);
      attendees.push({ name: str(name), email: e.includes('@') ? e : null });
    }
  }
  for (const typed of str(b.attendees).split(/[,;\n]/)) {
    const name = typed.trim();
    if (!name) continue;
    if (attendees.some((a) => a.name.toLowerCase() === name.toLowerCase())) continue;
    attendees.push({ name, email: null });
  }

  const organizerEmail = meeting ? str(meeting.organizerEmail) : '';
  const request: PrepRequest = {
    title: str(b.title) || (meeting ? str(meeting.title) : ''),
    attendees,
    organizer: meeting && (str(meeting.organizerName) || organizerEmail)
      ? { name: str(meeting.organizerName), email: organizerEmail.includes('@') ? organizerEmail : null }
      : null,
    description: meeting ? str(meeting.description) : '',
    notes: str(b.notes),
    startsAt: meeting ? str(meeting.startsAt) || null : null,
  };
  if (!request.title && attendees.length === 0 && !request.notes) return null;
  return request;
}
