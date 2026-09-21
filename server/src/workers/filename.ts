/**
 * Vault meeting-note filenames.
 *
 *   <CATEGORY> <Who|Topic> <MM.DD.YY>.md
 *
 * The convention is documented in ~/Documents/CX/CLAUDE.md and mirrored in
 * notes4chris/services/summariser.js. The date is ALWAYS last and ALWAYS
 * local time — see formatMeetingDate.
 */

/** Meeting Copilot writes to the vault's `Meetings/` grab bag. */
export const DEFAULT_CATEGORY = 'CXV';

/** Target ceiling for the whole basename, `.md` included. */
export const FILENAME_LIMIT = 40;

const SELF_NAMES = new Set([
  'chris', 'chris robinson', 'christopher', 'christopher robinson',
  'me', 'self',
]);

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
 * Chris is dropped — he attends everything. Returns [] when the list is
 * mostly raw usernames (a Meet/Zoom roster of handles names nobody).
 */
export function parseAttendees(attendees?: string | null): string[] {
  if (!attendees?.trim()) return [];

  const named = attendees
    .split(/[,;/\n]|\band\b/i)
    .map((p) => p.replace(/\(.*?\)/g, '').trim())
    .filter(Boolean)
    .filter((p) => p.split(/\s+/).length <= 4 && p.length <= 40)
    .filter((p) => !SELF_NAMES.has(p.toLowerCase()) && !NON_PEOPLE.has(p.toLowerCase()));

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

/** The meeting title reduced to content words, minus anything already said. */
export function topicFromTitle(title: string | undefined, people: string[]): string {
  const drop = new Set([
    ...TITLE_STOPWORDS,
    ...SELF_NAMES,
    ...people.map((p) => p.toLowerCase()),
    DEFAULT_CATEGORY.toLowerCase(),
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
 * `<CATEGORY> <Who|Topic> <MM.DD.YY>.md`, fitted under FILENAME_LIMIT.
 * The date is never truncated.
 */
export function buildMeetingFilename(opts: {
  title?: string;
  attendees?: string | null;
  startedAt?: number | string | Date | null;
  category?: string;
}): string {
  const category = opts.category ?? DEFAULT_CATEGORY;
  const datestr = formatMeetingDate(opts.startedAt);
  const people = parseAttendees(opts.attendees);
  const topic = topicFromTitle(opts.title, people);

  const middle = people.length ? peopleSlot(people) : topic;
  const build = (mid: string) => `${category} ${mid} ${datestr}.md`;

  const candidates = [middle];
  if (people.length === 2) candidates.push(`${people[0]} et al`, people[0]);
  candidates.push(topic, 'Meeting');

  for (const mid of candidates) {
    if (mid && build(mid).length <= FILENAME_LIMIT) return build(mid);
  }

  // Still too long: truncate the middle at a word boundary.
  const room = FILENAME_LIMIT - build('').length;
  const words = (middle || 'Meeting').split(/\s+/);
  const kept: string[] = [];
  for (const w of words) {
    if ([...kept, w].join(' ').length > room && kept.length) break;
    kept.push(w);
  }
  return build(kept.join(' ') || words[0].slice(0, Math.max(room, 3)));
}
