// Staged preps: a meeting prepared ahead of time, waiting on disk until the
// start form shows it. Claude (the meeting-copilot-prep skill) researches a meeting and
// writes everything the start form takes — title, agenda, attendees, private
// goals, projects, context files, the brief — through scripts/stage-prep.sh.
// The dashboard fills itself from the next one, so all that is left at meeting
// time is the Start button (which is also the consent affirmation).
//
// One JSON file per meeting in ~/.meeting-copilot/staged/. The CLI is the only
// writer and checks everything on the way in; the server only reads, and moves
// a prep into its session's folder (prep.json) when that session starts, so a
// prep never outlives or leaks across sessions (invariant #2).

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { normalizeExtractedItems } from '../intelligence/agenda.js';
import { isSupportedContextFile, type ContextDoc } from '../context/index.js';

export const STAGED_PREP_VERSION = 1;

export const LIMITS = {
  titleChars: 200,
  agendaItems: 10,
  agendaItemChars: 150,
  /** meeting.goals keeps 1,000 characters; more would be cut silently. */
  goalsChars: 1_000,
  /** The brief is pinned into every suggestion's context block (8,000 total). */
  briefChars: 3_000,
  sources: 10,
  attendees: 30,
} as const;

/** A prep with no end time lives this long past its start. */
const NO_END_GRACE_MS = 2 * 60 * 60 * 1000;
/** A prep with no times at all lives this long past its creation. */
const NO_TIMES_TTL_MS = 24 * 60 * 60 * 1000;
/** Expired preps are deleted once they have been expired this long. */
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

const KNOWN_FIELDS = new Set([
  'title', 'eventUid', 'startsAt', 'endsAt', 'attendees', 'agenda', 'goals',
  'projects', 'contextPaths', 'brief', 'sources', 'createdBy',
]);

export interface StagedAttendee {
  name: string;
  email: string | null;
}

export interface StagedSource {
  title: string;
  url: string;
}

export interface StagedPrep {
  version: typeof STAGED_PREP_VERSION;
  id: string;
  createdAt: string;
  createdBy: string;
  title: string;
  /** cxmail invite uid, when the prep is for a calendar invite. */
  eventUid: string | null;
  startsAt: string | null;
  endsAt: string | null;
  attendees: StagedAttendee[];
  agenda: string[];
  goals: string;
  projects: string[];
  contextPaths: string[];
  /** Markdown. */
  brief: string;
  sources: StagedSource[];
}

export interface NormalizeOptions {
  now?: Date;
  /** Project names the picker offers (scanProjects). Omit to skip the check. */
  knownProjects?: string[];
  pathExists?: (path: string) => boolean;
  home?: string;
}

export interface NormalizeResult {
  prep: StagedPrep | null;
  errors: string[];
  warnings: string[];
}

export function stagedDir(): string {
  return process.env.COPILOT_STAGED_DIR ?? join(homedir(), '.meeting-copilot', 'staged');
}

/** Stable per meeting, so staging the same invite again replaces its prep. */
export function stagedPrepId(title: string, eventUid: string | null, startsAt: string | null): string {
  const key = eventUid ? `uid:${eventUid}` : `title:${title.toLowerCase()}|${startsAt ?? ''}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

function parseTime(value: unknown, field: string, errors: string[]): string | null {
  if (value === undefined || value === null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) {
    errors.push(`${field} is not a date: ${JSON.stringify(value)}`);
    return null;
  }
  return new Date(ms).toISOString();
}

function parseAttendees(value: unknown): StagedAttendee[] {
  const raw: unknown[] = typeof value === 'string' ? value.split(/[,;\n]/) : Array.isArray(value) ? value : [];
  const out: StagedAttendee[] = [];
  for (const item of raw) {
    let name = '';
    let email: string | null = null;
    if (typeof item === 'string') {
      name = item.trim();
    } else if (item && typeof item === 'object') {
      const a = item as { name?: unknown; email?: unknown };
      name = typeof a.name === 'string' ? a.name.trim() : '';
      const e = typeof a.email === 'string' ? a.email.trim() : '';
      email = e.includes('@') ? e : null;
      if (!name && email) name = email.split('@')[0];
    }
    if (!name) continue;
    if (out.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    out.push({ name, email });
  }
  return out.slice(0, LIMITS.attendees);
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean);
}

/**
 * Check and normalize what the skill wrote. Hard limits are errors (the skill
 * must fix them — a silently cut brief or agenda is worse than a refusal);
 * things that can simply be dropped are warnings.
 */
export function normalizeStagedInput(input: unknown, opts: NormalizeOptions = {}): NormalizeResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { prep: null, errors: ['Expected a JSON object'], warnings };
  }
  const b = input as Record<string, unknown>;
  const now = opts.now ?? new Date();
  const home = opts.home ?? homedir();
  const pathExists = opts.pathExists ?? existsSync;

  for (const key of Object.keys(b)) {
    if (!KNOWN_FIELDS.has(key)) warnings.push(`Ignored unknown field "${key}"`);
  }

  const title = typeof b.title === 'string' ? b.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) errors.push('title is required');
  else if (title.length > LIMITS.titleChars) errors.push(`title is ${title.length} characters; the limit is ${LIMITS.titleChars}`);

  const eventUid = typeof b.eventUid === 'string' && b.eventUid.trim() ? b.eventUid.trim() : null;
  const startsAt = parseTime(b.startsAt, 'startsAt', errors);
  const endsAt = parseTime(b.endsAt, 'endsAt', errors);
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) errors.push('endsAt must be after startsAt');
  if (endsAt && Date.parse(endsAt) <= now.getTime()) errors.push(`The meeting already ended (${endsAt})`);
  if (!startsAt) warnings.push('No startsAt: the prep lasts 24 hours and sorts after dated ones');
  else if (!endsAt) warnings.push('No endsAt: the wrap-up check will not know when the meeting ends');

  const rawAgenda = stringList(b.agenda);
  const agenda = normalizeExtractedItems(rawAgenda);
  if (agenda.length === 0) errors.push('agenda needs at least one item');
  if (agenda.length > LIMITS.agendaItems) errors.push(`agenda has ${agenda.length} items; the limit is ${LIMITS.agendaItems}`);
  for (const item of agenda) {
    if (item.length > LIMITS.agendaItemChars) {
      errors.push(`Agenda item is ${item.length} characters (limit ${LIMITS.agendaItemChars}): "${item.slice(0, 60)}…"`);
    }
  }
  if (rawAgenda.length > agenda.length && agenda.length <= LIMITS.agendaItems) {
    warnings.push(`Dropped ${rawAgenda.length - agenda.length} empty or duplicate agenda item(s)`);
  }

  const goals = (Array.isArray(b.goals) ? stringList(b.goals).join('\n') : typeof b.goals === 'string' ? b.goals : '').trim();
  if (goals.length > LIMITS.goalsChars) errors.push(`goals is ${goals.length} characters; the limit is ${LIMITS.goalsChars}`);

  const brief = typeof b.brief === 'string' ? b.brief.trim() : '';
  if (brief.length > LIMITS.briefChars) errors.push(`brief is ${brief.length} characters; the limit is ${LIMITS.briefChars} — tighten it`);
  if (!brief) warnings.push('No brief: the copilot starts with the agenda and attendees only');

  const projects: string[] = [];
  for (const name of stringList(b.projects)) {
    if (!opts.knownProjects) {
      projects.push(name);
      continue;
    }
    const match = opts.knownProjects.find((p) => p.toLowerCase() === name.toLowerCase());
    if (match) {
      if (!projects.includes(match)) projects.push(match);
    } else {
      warnings.push(`Dropped unknown project "${name}" (not in the start form's project list)`);
    }
  }

  const contextPaths: string[] = [];
  for (const raw of stringList(b.contextPaths)) {
    const path = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
    if (!isAbsolute(path)) {
      warnings.push(`Dropped context path "${raw}": it must be absolute`);
    } else if (!pathExists(path)) {
      warnings.push(`Dropped context path "${raw}": it does not exist`);
    } else if (!isDirectory(path) && !isSupportedContextFile(path)) {
      warnings.push(`Dropped context path "${raw}": the copilot only reads .md, .txt, .json and .yaml files`);
    } else if (!contextPaths.includes(path)) {
      contextPaths.push(path);
    }
  }

  const sources: StagedSource[] = [];
  if (Array.isArray(b.sources)) {
    for (const s of b.sources) {
      if (!s || typeof s !== 'object') continue;
      const { title: t, url } = s as { title?: unknown; url?: unknown };
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
      sources.push({ title: typeof t === 'string' && t.trim() ? t.trim() : url, url });
    }
  }
  if (sources.length > LIMITS.sources) {
    warnings.push(`Kept the first ${LIMITS.sources} of ${sources.length} sources`);
    sources.length = LIMITS.sources;
  }

  if (errors.length > 0) return { prep: null, errors, warnings };

  const prep: StagedPrep = {
    version: STAGED_PREP_VERSION,
    id: stagedPrepId(title, eventUid, startsAt),
    createdAt: now.toISOString(),
    createdBy: typeof b.createdBy === 'string' && b.createdBy.trim() ? b.createdBy.trim().slice(0, 40) : 'claude',
    title,
    eventUid,
    startsAt,
    endsAt,
    attendees: parseAttendees(b.attendees),
    agenda,
    goals,
    projects,
    contextPaths,
    brief,
    sources,
  };
  return { prep, errors, warnings };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** When a prep stops being offered: the meeting's end, else start + 2h, else creation + 24h. */
export function stagedPrepExpiry(prep: Pick<StagedPrep, 'createdAt' | 'startsAt' | 'endsAt'>): number {
  if (prep.endsAt) return Date.parse(prep.endsAt);
  if (prep.startsAt) return Date.parse(prep.startsAt) + NO_END_GRACE_MS;
  return Date.parse(prep.createdAt) + NO_TIMES_TTL_MS;
}

/** Atomic write: a reader never sees half a file. Replaces the same meeting's prep. */
export function saveStagedPrep(prep: StagedPrep, dir: string = stagedDir()): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${prep.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(prep, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/** A stored file, re-checked on read: it may be hand-edited or from a newer app. */
function parseStoredPrep(raw: unknown): { prep: StagedPrep | null; reason?: string } {
  if (!raw || typeof raw !== 'object') return { prep: null, reason: 'not a JSON object' };
  const p = raw as Record<string, unknown>;
  if (p.version !== STAGED_PREP_VERSION) {
    return { prep: null, reason: `version ${String(p.version)} (this app reads version ${STAGED_PREP_VERSION}) — update Meeting Copilot` };
  }
  const ok = typeof p.id === 'string'
    && typeof p.title === 'string'
    && typeof p.createdAt === 'string'
    && Array.isArray(p.agenda)
    && Array.isArray(p.attendees)
    && Array.isArray(p.projects)
    && Array.isArray(p.contextPaths)
    && Array.isArray(p.sources)
    && typeof p.goals === 'string'
    && typeof p.brief === 'string';
  if (!ok) return { prep: null, reason: 'missing fields' };
  return { prep: raw as StagedPrep };
}

export interface ListResult {
  preps: StagedPrep[];
  skipped: { file: string; reason: string }[];
}

/**
 * Preps still waiting, soonest meeting first (undated ones after, newest first).
 * Deletes preps that expired more than a day ago.
 */
export function listStagedPreps(dir: string = stagedDir(), now: Date = new Date()): ListResult {
  const result: ListResult = { preps: [], skipped: [] };
  if (!existsSync(dir)) return result;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return result;
  }
  for (const file of files) {
    const path = join(dir, file);
    let parsed: { prep: StagedPrep | null; reason?: string };
    try {
      parsed = parseStoredPrep(JSON.parse(readFileSync(path, 'utf8')));
    } catch (err) {
      parsed = { prep: null, reason: `unreadable: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!parsed.prep) {
      result.skipped.push({ file, reason: parsed.reason ?? 'invalid' });
      continue;
    }
    const expiry = stagedPrepExpiry(parsed.prep);
    if (expiry <= now.getTime()) {
      if (now.getTime() - expiry > PRUNE_AFTER_MS) {
        try { rmSync(path, { force: true }); } catch { /* next list tries again */ }
      }
      continue;
    }
    result.preps.push(parsed.prep);
  }
  result.preps.sort((a, b) => {
    const as = a.startsAt ? Date.parse(a.startsAt) : null;
    const bs = b.startsAt ? Date.parse(b.startsAt) : null;
    if (as !== null && bs !== null) return as - bs;
    if (as !== null) return -1;
    if (bs !== null) return 1;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
  return result;
}

export function getStagedPrep(id: string, dir: string = stagedDir()): StagedPrep | null {
  if (!/^[0-9a-f]{12}$/.test(id)) return null;
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return parseStoredPrep(JSON.parse(readFileSync(path, 'utf8'))).prep;
  } catch {
    return null;
  }
}

export function removeStagedPrep(id: string, dir: string = stagedDir()): boolean {
  if (!/^[0-9a-f]{12}$/.test(id)) return false;
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

export interface AttachedPrep {
  brief: string;
  /** 'staged' = prepared ahead; 'form' = the start form's Prep button. */
  origin: 'staged' | 'form';
  prepId: string | null;
}

/**
 * Give a just-started session its prep: move the staged file into the
 * session's folder as prep.json (so it is consumed exactly once and kept with
 * the meeting), or record the Prep button's brief there. The brief handed to
 * the copilot is the one the form showed — `brief` when sent (a re-prep on a
 * prepped form replaces the staged one), else the staged file's. A staged id
 * that is gone (removed, expired) falls back to `brief`. Null = nothing to attach.
 */
export function attachPrepToSession(
  message: { prepId?: unknown; brief?: unknown; sources?: unknown },
  sessionDir: string,
  dir: string = stagedDir(),
): AttachedPrep | null {
  const target = join(sessionDir, 'prep.json');
  const shown = typeof message.brief === 'string' ? message.brief.trim().slice(0, LIMITS.briefChars) : '';
  if (typeof message.prepId === 'string' && message.prepId) {
    const prep = getStagedPrep(message.prepId, dir);
    if (prep) {
      const source = join(dir, `${prep.id}.json`);
      try {
        renameSync(source, target);
      } catch {
        // Different volume (a COPILOT_STAGED_DIR override): copy, then remove.
        copyFileSync(source, target);
        rmSync(source, { force: true });
      }
      const brief = shown || prep.brief;
      return brief ? { brief, origin: 'staged', prepId: prep.id } : null;
    }
  }
  if (!shown) return null;
  const sources = Array.isArray(message.sources) ? message.sources.slice(0, LIMITS.sources) : [];
  writeFileSync(target, JSON.stringify({ origin: 'form', brief: shown, sources }, null, 2) + '\n', { mode: 0o600 });
  return { brief: shown, origin: 'form', prepId: null };
}

/** The brief as a context doc, pinned so relevance ranking never drops it. */
export function prepBriefDoc(brief: string, sessionDir: string): ContextDoc {
  return {
    name: 'Meeting prep brief',
    relativePath: 'prep.json',
    dirPath: sessionDir,
    content: brief,
    firstLine: 'Research on this meeting and its attendees, done before it started',
    sizeChars: brief.length,
    pinned: true,
  };
}
