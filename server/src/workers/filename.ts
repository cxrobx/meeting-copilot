/**
 * Vault meeting-note filenames.
 *
 *   <CATEGORY> <Who|Topic> <MM.DD.YY>.md
 *
 * The date is ALWAYS last and ALWAYS local time — see formatMeetingDate.
 */

import { getVaultProfile } from './vaultProfile.js';

/*
 * Meeting Copilot writes to the vault's `Meetings/` catch-all, a folder with no
 * code of its own, so the category is whatever the CONTENT earns: whole-token
 * match over title + attendees, first hit wins. No hit → NO prefix; there is
 * deliberately no default code, because a default stamps itself on everything
 * that matched nothing. The codes and the words that earn them, and the user's
 * own names, are one person's vault, so they come from the vault profile
 * (./vaultProfile.ts), never from this file.
 */

/** Target ceiling for the whole basename, `.md` included. */
export const FILENAME_LIMIT = 40;

/** Roles the transcriber emits that are not people. */
const NON_PEOPLE = new Set([
  'audience', 'audience speaker', 'speaker', 'unknown', 'unknown speaker',
  'remote speaker', 'local speaker', 'participant', 'participants',
  'everyone', 'all', 'team', 'guest', 'host', 'others', 'n/a', 'none',
]);

const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'professor', 'sir', 'rev',
  'mr.', 'mrs.', 'ms.', 'dr.',
]);

const TITLE_STOPWORDS = new Set([
  'call', 'calls', 'meeting', 'meetings', 'notes', 'note', 'summary',
  'w', 'with', 'and', 'the', 'a', 'an', 'for', 'on', 'of', 'to', 're',
  'talk', 'chat', 'session', 'catch', 'up', 'recording', 'transcript',
  'discussion', 'convo', 'conversation', 'untitled', 'live',
]);

const CALENDAR_CRUFT =
  /^(accepted|declined|tentative|invitation|updated invitation|canceled|cancelled)\s*[:-]?\s*/i;

const TOPIC_ALIASES: Record<string, string> = {
  'business development': 'Biz Dev',
  'biz dev': 'Biz Dev',
  development: 'Dev',
  dev: 'Dev',
  e2e: 'E2E',
  kickoff: 'Kickoff',
  'kick off': 'Kickoff',
  sync: 'Sync',
  demo: 'Demo',
};

/**
 * `MM.DD.YY` in LOCAL time.
 *
 * NEVER use `toISOString()` here. It renders UTC, so any meeting after
 * ~20:00 ET is stamped with the next day's date — the bug that put
 * `2026-04-29-globex-sync` on a call that happened on the 28th.
 */
export function formatMeetingDate(startedAt?: number | string | Date | null): string {
  const date =
    startedAt === undefined || startedAt === null ? new Date() : new Date(startedAt);
  const d = Number.isNaN(date.getTime()) ? new Date() : date;
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const year = String(d.getFullYear()).slice(-2);
  return `${month}.${day}.${year}`;
}

function isRawUsername(name: string): boolean {
  return /\d/.test(name) || name.includes('.') || name.includes('@');
}

function firstName(name: string): string {
  for (const raw of name.split(/\s+/)) {
    const tok = raw.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9'-]+$/g, '');
    if (!tok || HONORIFICS.has(tok.toLowerCase())) continue;
    return tok === tok.toUpperCase() ? tok : tok[0].toUpperCase() + tok.slice(1);
  }
  return '';
}

/**
 * Counterpart first names from the session's free-text attendees field.
 * The user is dropped — they attend everything. Returns [] when the list is
 * mostly raw usernames (a Meet/Zoom roster of handles names nobody).
 */
export function parseAttendees(attendees?: string | null): string[] {
  if (!attendees?.trim()) return [];

  const selfNames = getVaultProfile().selfNames;
  const named = attendees
    .split(/[,;/\n]|\band\b/i)
    .map((p) => p.replace(/\(.*?\)/g, '').trim())
    .filter(Boolean)
    .filter((p) => p.split(/\s+/).length <= 4 && p.length <= 40)
    .filter((p) => !selfNames.has(p.toLowerCase()) && !NON_PEOPLE.has(p.toLowerCase()));

  if (!named.length) return [];
  const usernames = named.filter(isRawUsername);
  if (usernames.length * 2 > named.length) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of named.filter((n) => !isRawUsername(n))) {
    const f = firstName(p);
    if (f && !seen.has(f.toLowerCase())) {
      seen.add(f.toLowerCase());
      out.push(f);
    }
  }
  return out;
}

/** The category code the title and attendees earn, or '' — '' is the answer. */
export function categoryForContent(title?: string, attendees?: string | null): { code: string; words: string[] } {
  const haystack = ` ${[title, attendees].filter(Boolean).join(' ')} `
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  for (const [code, keywords] of getVaultProfile().categoryByContent) {
    const hits = keywords.filter((kw) => haystack.includes(` ${kw} `));
    if (hits.length) return { code, words: hits.flatMap((kw) => kw.split(' ')) };
  }
  return { code: '', words: [] };
}

/**
 * The meeting title reduced to content words, minus anything already said —
 * the people slot, and the words that earned the category (`Globex Portal Sync`
 * under Globex is `Portal Sync`).
 */
export function topicFromTitle(title: string | undefined, people: string[], categoryWords: string[] = []): string {
  const drop = new Set([
    ...TITLE_STOPWORDS,
    ...getVaultProfile().selfNames,
    ...people.map((p) => p.toLowerCase()),
    ...categoryWords,
  ]);

  const tokens = (title ?? '')
    .replace(CALENDAR_CRUFT, '')
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z0-9:&'/]/g, ''))
    .filter((t) => t && !drop.has(t.toLowerCase()) && !/^\d+$/.test(t));

  const phrase = tokens.join(' ').toLowerCase();
  if (TOPIC_ALIASES[phrase]) return TOPIC_ALIASES[phrase];

  return tokens
    .slice(0, 3)
    .map((t) => TOPIC_ALIASES[t.toLowerCase()] ?? t[0].toUpperCase() + t.slice(1))
    .join(' ');
}

function peopleSlot(people: string[]): string {
  if (people.length === 1) return people[0];
  if (people.length === 2) return `${people[0]}, ${people[1]}`;
  return `${people[0]} et al`;
}

/**
 * `<CATEGORY> <Who|Topic> <MM.DD.YY>.md`, fitted under FILENAME_LIMIT. The
 * category is omitted when the content earns none. The date is never
 * truncated.
 */
export function buildMeetingFilename(opts: {
  title?: string;
  attendees?: string | null;
  startedAt?: number | string | Date | null;
  category?: string;
}): string {
  const earned = categoryForContent(opts.title, opts.attendees);
  const category = opts.category ?? earned.code;
  const datestr = formatMeetingDate(opts.startedAt);
  const people = parseAttendees(opts.attendees);
  const topic = topicFromTitle(opts.title, people, opts.category === undefined ? earned.words : []);

  const middle = (people.length ? peopleSlot(people) : topic) || 'Meeting';
  const build = (mid: string) => `${[category, mid, datestr].filter(Boolean).join(' ')}.md`;

  // The compression ladder: `et al` → drop the second attendee → the topic →
  // truncate. The literal `Meeting` is NOT a rung: it always fits, so when it
  // sat ahead of truncation every topic over budget became the word "Meeting"
  // (two one-off calls were filed as `<CODE> Meeting <date>.md`). It is only
  // for a middle that is genuinely empty.
  const candidates = [middle];
  if (people.length === 2) candidates.push(`${people[0]} et al`, people[0]);
  if (topic) candidates.push(topic);

  for (const mid of candidates) {
    if (build(mid).length <= FILENAME_LIMIT) return build(mid);
  }

  // Still too long: truncate the middle at a word boundary, keeping at least
  // one word — sliced if a single word is wider than the room.
  const room = FILENAME_LIMIT - build('x').length + 1;
  const words = middle.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const w of words) {
    if ([...kept, w].join(' ').length > room) break;
    kept.push(w);
  }
  return build(kept.join(' ') || words[0]!.slice(0, Math.max(room, 3)));
}
