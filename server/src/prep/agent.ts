// Meeting prep, step 2: a quick research agent. It starts from what the
// user's own records say (prep/gather.ts), researches the other side on the
// web — the people, their companies, what they do, recent news — works out
// where the two sides overlap, and hands back a brief plus a short agenda the
// live tracker can check off.
//
// Runs on the `claude` CLI (subscription — claudeSuggest strips any API key
// from the child env), so a prep costs nothing metered. If web research fails
// or runs long, a tool-less pass over the local records still produces an
// agenda: the button must never come back empty-handed when there is context.

import { claudeSuggest } from '../claude-cli.js';
import { MODEL_CONFIG, EFFORT_CONFIG } from '../model-config.js';
import { normalizeExtractedItems } from '../intelligence/agenda.js';
import { formatPrepContext, gatherPrepContext, type PrepContext, type PrepRequest } from './gather.js';

export interface PrepSource {
  title: string;
  url: string;
}

export interface PrepResult {
  /** Markdown. */
  brief: string;
  agenda: string[];
  sources: PrepSource[];
  /** 'web' = researched; 'local' = drafted from the user's records only. */
  mode: 'web' | 'local';
  stats: { people: number; emails: number; pastMeetings: number; vaultNotes: number };
}

export interface RunPrepDeps {
  suggest?: typeof claudeSuggest;
  gather?: (request: PrepRequest) => PrepContext;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  /** settings.aboutMe — empty falls back to DEFAULT_ABOUT_ME. */
  aboutMe?: string;
  webTimeoutMs?: number;
  now?: Date;
}

/**
 * Used when settings.json has no `aboutMe`. Deliberately says nothing about
 * any real person: who the user is lives in their own settings, not the repo.
 */
export const DEFAULT_ABOUT_ME = `No profile has been set (Settings → About me). Research the attendees and their companies on their own terms, and do not guess at the user's background, business or goals.`;

const WEB_TIMEOUT_MS = 120_000;
const MAX_AGENDA_ITEMS = 10;
const MAX_ITEM_CHARS = 150;
const MAX_SOURCES = 10;

const OUTPUT_FORMAT = `Reply in exactly this format — three tagged sections, nothing before or after:

<brief>
### Who they are
…
### Their company
…
### How you're connected
…
### Overlap & openings
…
### Watch-outs
… (only if there is something real — otherwise leave this heading out)
</brief>
<agenda>
- item
- item
</agenda>
<sources>
- [Page title](https://…)
</sources>`;

const AGENDA_RULES = `Agenda rules — the live tracker checks these off as they are discussed, so:
- 5–8 items, each under 70 characters, phrased as a topic or question Chris raises.
- If <chris_notes> has items, keep them first, in his wording.
- Specific to this meeting and these people ("How does Juniper decide build vs buy for AI?"), never generic ("Discuss AI").
- Order them the way the conversation should flow: rapport and context → their world → overlap → a concrete next step.`;

function webSystemPrompt(now: Date): string {
  return `You prepare Chris for a meeting that starts soon. Today is ${now.toDateString()}. You get what his own records say about it — the invite, email threads, past meetings, notes — and you research the other side on the web.

Research, fast (at most 6 searches; run independent searches in the same turn; fetch a page only when a search snippet is not enough):
1. Pin down who each attendee is. Anchor on the email domain, the company names and what the emails say. A common name must match on employer or domain — if you cannot confirm the person, say so instead of guessing.
2. The person: current role, background, earlier companies.
3. Every company tied to them (the email domain, employers named in the emails): what it does, who it serves, size or stage, anything recent. For a new or side venture, say what it offers.
4. Overlap with Chris (profile below): shared background, where each could help the other, partnership or referral angles, what Chris could offer or learn.

Never invent facts. Anything that is not from the emails or a page you actually read gets "(unverified)". Keep the brief under 350 words — bullets, no filler.

${AGENDA_RULES}

${OUTPUT_FORMAT}`;
}

function localSystemPrompt(now: Date): string {
  return `You prepare Chris for a meeting that starts soon. Today is ${now.toDateString()}. There is no web access for this pass — work only from his records below (invite, email threads, past meetings, notes) and his profile. Say plainly what the records do not tell you rather than filling gaps. Keep the brief under 250 words — bullets, no filler. Leave <sources> empty.

${AGENDA_RULES}

${OUTPUT_FORMAT}`;
}

function buildPrompt(context: string, aboutMe: string): string {
  return `<chris_profile>\n${aboutMe}\n</chris_profile>\n\n${context}`;
}

export async function runMeetingPrep(request: PrepRequest, deps: RunPrepDeps = {}): Promise<PrepResult> {
  const progress = (msg: string) => {
    try {
      deps.onProgress?.(msg);
    } catch {
      // a closed client must not break the run
    }
  };
  const now = deps.now ?? new Date();
  const suggest = deps.suggest ?? claudeSuggest;
  const ctx = (deps.gather ?? gatherPrepContext)(request);
  const stats = {
    people: ctx.people.length,
    emails: ctx.emails.length,
    pastMeetings: ctx.pastMeetings.length,
    vaultNotes: ctx.vaultNotes.length,
  };
  progress(describeGathered(ctx));

  const prompt = buildPrompt(formatPrepContext(ctx), deps.aboutMe?.trim() || DEFAULT_ABOUT_ME);

  // ── Web research ──
  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort();
  deps.signal?.addEventListener('abort', onOuterAbort);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, deps.webTimeoutMs ?? WEB_TIMEOUT_MS);
  try {
    progress(ctx.people.length ? `Researching ${ctx.people.map((p) => p.name).join(', ')}…` : 'Researching the meeting…');
    const raw = await suggest(prompt, webSystemPrompt(now), ctl.signal, ['WebSearch', 'WebFetch'], {
      model: MODEL_CONFIG.prep,
      effort: EFFORT_CONFIG.prep,
      maxTurns: 14,
      onToolUse: (name, input) => {
        const line = describeToolUse(name, input);
        if (line) progress(line);
      },
    });
    const parsed = parsePrepResponse(raw);
    if (parsed && parsed.agenda.length) return { ...parsed, mode: 'web', stats };
    console.warn(`[Prep] web pass unparseable (${raw.length} chars) — falling back to local`);
    progress('Research came back garbled — drafting from your records instead');
  } catch (err) {
    if (deps.signal?.aborted) throw new Error('Aborted');
    console.warn(`[Prep] web pass failed: ${timedOut ? 'timed out' : err instanceof Error ? err.message : err}`);
    progress(timedOut ? 'Web research ran long — drafting from your records instead' : 'Web research failed — drafting from your records instead');
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onOuterAbort);
  }

  // ── Local-only fallback ──
  if (deps.signal?.aborted) throw new Error('Aborted');
  const raw = await suggest(prompt, localSystemPrompt(now), deps.signal, undefined, { model: MODEL_CONFIG.prep, effort: EFFORT_CONFIG.prep });
  const parsed = parsePrepResponse(raw);
  if (!parsed) throw new Error('Prep came back unreadable — try again');
  return { ...parsed, sources: [], mode: 'local', stats };
}

function describeGathered(ctx: PrepContext): string {
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const who = ctx.people.length ? ` with ${ctx.people.map((p) => p.name).join(', ')}` : '';
  return `Your records: ${n(ctx.emails.length, 'email')}, ${n(ctx.pastMeetings.length, 'past meeting')}, ${n(ctx.vaultNotes.length, 'vault note')}${who}`;
}

export function describeToolUse(name: string, input: Record<string, unknown>): string | null {
  if (name === 'WebSearch' && typeof input.query === 'string') return `Searching: ${input.query}`;
  if (name === 'WebFetch' && typeof input.url === 'string') {
    try {
      return `Reading ${new URL(input.url).hostname.replace(/^www\./, '')}`;
    } catch {
      return 'Reading a page';
    }
  }
  return null;
}

/**
 * Pull the three tagged sections out of the agent's reply. Returns null when
 * there is neither a brief nor an agenda — anything less is still useful.
 */
export function parsePrepResponse(raw: string): Omit<PrepResult, 'mode' | 'stats'> | null {
  if (!raw || typeof raw !== 'string') return null;
  const section = (name: string): string | null => {
    const m = raw.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? m[1].trim() : null;
  };
  const brief = section('brief') ?? '';
  const agendaText = section('agenda') ?? '';
  const agenda = normalizeExtractedItems(
    agendaText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l.length <= MAX_ITEM_CHARS),
  ).slice(0, MAX_AGENDA_ITEMS);
  if (!brief && agenda.length === 0) return null;
  return { brief, agenda, sources: parseSources(section('sources') ?? '') };
}

function parseSources(text: string): PrepSource[] {
  const out: PrepSource[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const md = line.match(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/);
    const bare = md ? null : line.match(/https?:\/\/[^\s)>\]]+/);
    const url = md ? md[2] : bare ? bare[0] : null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = md ? md[1].trim() : line.replace(url, '').replace(/^[\s*•-]+|[\s:—–-]+$/g, '').trim();
    out.push({ title: title || hostOf(url), url });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
