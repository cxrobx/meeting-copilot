/**
 * What the meeting chat knows: one text snapshot of the meeting, rebuilt for
 * every turn, and the user's turn with whatever they attached from the
 * dashboard (a highlighted line, a card, an evidence tab, the pulse).
 *
 * Pure: chat/service.ts reads the session and hands the pieces in, so the
 * budgets here are testable without a database.
 */

export interface ChatTranscriptLine {
  label: string;
  text: string;
  /** Epoch ms. */
  timestamp: number;
}

export interface ChatSummary {
  summary: string;
  /** Epoch ms of the first and last transcript line it covers. */
  windowStart: number;
  windowEnd: number;
}

export interface ChatPulseItem {
  text: string;
  why?: string;
}

export interface ChatPulse {
  status: string;
  read: string;
  escalations: ChatPulseItem[];
  closeOut: ChatPulseItem[];
  missed: ChatPulseItem[];
  minutesIn: number;
}

export interface ChatCard {
  title: string;
  type: string;
  state: string;
  text: string;
}

export interface ChatTab {
  title: string;
  url: string | null;
  note: string;
}

export interface MeetingSnapshotInput {
  title: string;
  attendees: string;
  /** Epoch ms; null when the session row has none. */
  startedAt: number | null;
  endedAt: number | null;
  live: boolean;
  now: number;
  agenda: string;
  goals: string;
  brief: string;
  /** Reference documents, already formatted (context/index.ts buildContextBlock). */
  docs: string;
  pulse: ChatPulse | null;
  tabs: ChatTab[];
  /** Oldest first, as stored. */
  cards: ChatCard[];
  /** Oldest first. */
  transcript: ChatTranscriptLine[];
  summaries: ChatSummary[];
}

// An hour of talk is ~9,000 words, ~50,000 characters, so most meetings go in
// whole. At gpt-6-luna's $0.10 per million input tokens the full budget costs
// about $0.004 a turn; web search, when it runs, costs more than the context.
export const SNAPSHOT_LIMITS = {
  transcriptChars: 60_000,
  summaryChars: 800,
  cardsChars: 12_000,
  perCardChars: 2_000,
  briefChars: 3_000,
  docsChars: 8_000,
  goalsChars: 1_500,
  agendaChars: 3_000,
};

export const CHAT_SYSTEM = [
  'You are the chat inside Meeting Copilot, a live meeting assistant. The user is in the meeting described below (or has just finished it) and is typing to you between sentences.',
  'Answer from the meeting first: its transcript, agenda, pulse, prep brief, evidence and the copilot\'s cards. Use web search only when the question needs outside or current facts.',
  'Lead with the answer. Keep it short, under 150 words, unless they ask for something longer such as a draft or a list. No preamble.',
  'In the transcript, "You" is the user (their microphone) and "Meeting" is everyone else on the call. When you quote the meeting, quote it exactly and give its [mm:ss] time.',
  'If the meeting does not cover what they ask, say so plainly instead of guessing.',
  'Items the user attached from the dashboard are numbered [1], [2] and so on. "This" or "that" usually means the latest one.',
].join('\n');

/** mm:ss from the start, h:mm:ss past an hour. */
export function clock(epochMs: number, startedAt: number | null): string {
  const s = Math.max(0, Math.round((epochMs - (startedAt ?? epochMs)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function speaker(label: string): string {
  return label.replace(/^\[|\]$/g, '').trim() || 'Unknown';
}

export function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}…`;
}

/**
 * The newest lines word for word up to the budget; anything older is carried
 * by the 5-minute summaries that cover it, or noted as left out.
 */
export function transcriptSection(
  lines: ChatTranscriptLine[],
  summaries: ChatSummary[],
  startedAt: number | null,
  budgetChars: number = SNAPSHOT_LIMITS.transcriptChars,
): string {
  if (lines.length === 0) return 'Nothing has been said yet.';
  const start = startedAt ?? lines[0]!.timestamp;
  const formatted = lines.map((l) => `[${clock(l.timestamp, start)}] ${speaker(l.label)}: ${l.text.trim()}`);

  let used = 0;
  let first = formatted.length;
  for (let i = formatted.length - 1; i >= 0; i--) {
    const len = formatted[i]!.length + 1;
    // The newest line always goes in, whatever its length.
    if (used + len > budgetChars && i < formatted.length - 1) break;
    used += len;
    first = i;
  }
  const kept = formatted.slice(first).join('\n');
  if (first === 0) return kept;

  const cutoff = lines[first]!.timestamp;
  const earlier = summaries
    .filter((s) => s.windowStart < cutoff)
    .map((s) => `- [${clock(s.windowStart, start)}–${clock(s.windowEnd, start)}] ${clip(s.summary, SNAPSHOT_LIMITS.summaryChars)}`);
  const head = earlier.length
    ? `Earlier, summarized (${first} lines not shown word for word):\n${earlier.join('\n')}`
    : `(${first} earlier lines are not shown.)`;
  return `${head}\n\nWord for word from [${clock(cutoff, start)}]:\n${kept}`;
}

const PULSE_STATUS: Record<string, string> = { on_track: 'on track', drifting: 'drifting', stuck: 'stuck' };

function pulseSection(p: ChatPulse): string {
  const list = (title: string, items: ChatPulseItem[]) =>
    items.length ? `\n${title}:\n${items.map((i) => `- ${i.text}${i.why ? ` (${i.why})` : ''}`).join('\n')}` : '';
  return `Minute ${p.minutesIn}: ${PULSE_STATUS[p.status] ?? p.status}. ${p.read}` +
    list('Escalate now', p.escalations) +
    list('Close out before the end', p.closeOut) +
    list('May have been missed', p.missed);
}

/** Newest first, whole cards only, until the budget runs out. */
function cardsSection(cards: ChatCard[]): string {
  const out: string[] = [];
  let used = 0;
  for (const c of [...cards].reverse()) {
    const state = c.state === 'completed' ? '' : `, ${c.state}`;
    const block = `### ${c.title} (${c.type}${state})\n${clip(c.text, SNAPSHOT_LIMITS.perCardChars) || '(no content yet)'}`;
    if (used + block.length > SNAPSHOT_LIMITS.cardsChars) {
      out.push(`(${cards.length - out.length} older cards not shown.)`);
      break;
    }
    used += block.length;
    out.push(block);
  }
  return out.join('\n\n');
}

function minutesBetween(a: number, b: number): number {
  return Math.max(0, Math.round((b - a) / 60_000));
}

export function buildMeetingSnapshot(input: MeetingSnapshotInput): string {
  const sections: string[] = [];
  const head = [`Title: ${input.title.trim() || '(untitled)'}`];
  if (input.attendees.trim()) head.push(`Attendees: ${input.attendees.trim()}`);
  if (input.startedAt) {
    const at = new Date(input.startedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    head.push(input.live || !input.endedAt
      ? `Live now, ${minutesBetween(input.startedAt, input.now)} minutes in (started ${at}).`
      : `Ended after ${minutesBetween(input.startedAt, input.endedAt)} minutes (started ${at}).`);
  }
  sections.push(`# The meeting\n${head.join('\n')}`);

  const add = (title: string, body: string, max?: number) => {
    const text = max ? clip(body, max) : body.trim();
    if (text) sections.push(`## ${title}\n${text}`);
  };
  add('Agenda', input.agenda, SNAPSHOT_LIMITS.agendaChars);
  add("The user's private goals for this meeting", input.goals, SNAPSHOT_LIMITS.goalsChars);
  add('Prep brief (researched before the meeting)', input.brief, SNAPSHOT_LIMITS.briefChars);
  if (input.tabs.length) {
    add('Evidence tabs prepared for the meeting', input.tabs
      .map((t) => `- ${t.title}${t.url ? ` <${t.url}>` : ''}${t.note ? `: ${t.note}` : ''}`)
      .join('\n'));
  }
  if (input.pulse) add('Latest meeting pulse (the copilot\'s read of the whole meeting)', pulseSection(input.pulse));
  if (input.cards.length) add("The copilot's cards, newest first", cardsSection(input.cards));
  add('Reference documents', input.docs, SNAPSHOT_LIMITS.docsChars);
  sections.push(`## Transcript\n${transcriptSection(input.transcript, input.summaries, input.startedAt)}`);
  return sections.join('\n\n');
}

// ─── Attachments ───────────────────────────────────────────────────────────

export type ChatAttachmentKind = 'quote' | 'card' | 'tab' | 'pulse' | 'answer';
const KINDS: ChatAttachmentKind[] = ['quote', 'card', 'tab', 'pulse', 'answer'];

export interface ChatAttachment {
  kind: ChatAttachmentKind;
  /** What the chip says: "Transcript", a card's title, a tab's title. */
  label: string;
  text: string;
  /** What surrounds a quote: the lines around it, or the card it came from. */
  context?: string;
  actionId?: string;
  /** An evidence tab, by its index in the session's prep.json; the server fills its text. */
  tabIndex?: number;
}

export const ATTACH_LIMITS = { count: 6, labelChars: 120, textChars: 6_000, contextChars: 2_000 };

/** Whatever the client sent, as at most six well-formed attachments. */
export function normalizeAttachments(raw: unknown): ChatAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatAttachment[] = [];
  for (const item of raw) {
    if (out.length >= ATTACH_LIMITS.count) break;
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const kind = KINDS.find((k) => k === r.kind);
    if (!kind) continue;
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const a: ChatAttachment = {
      kind,
      label: str(r.label, ATTACH_LIMITS.labelChars) || kind,
      text: str(r.text, ATTACH_LIMITS.textChars),
    };
    const context = str(r.context, ATTACH_LIMITS.contextChars);
    if (context && context !== a.text) a.context = context;
    const actionId = str(r.actionId, 100);
    if (actionId) a.actionId = actionId;
    if (kind === 'tab') {
      const i = Number(r.tabIndex);
      if (!Number.isInteger(i) || i < 0) continue;
      a.tabIndex = i;
    } else if (!a.text) {
      continue;
    }
    out.push(a);
  }
  return out;
}

/** An html snapshot as readable text: no scripts, styles or tags. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();
}

const KIND_NAMES: Record<ChatAttachmentKind, string> = {
  quote: 'Highlighted',
  card: 'Card',
  tab: 'Evidence tab',
  pulse: 'Meeting pulse',
  answer: 'Earlier answer',
};

/** The user's turn as the model reads it. `max` shortens attachments in older turns. */
export function renderUserTurn(text: string, attachments: ChatAttachment[], max: number = ATTACH_LIMITS.textChars): string {
  const question = text.trim() || 'What matters here?';
  if (!attachments.length) return question;
  const lines = attachments.map((a, i) => {
    const name = a.kind === 'quote' ? `${KIND_NAMES.quote} in ${a.label}` : `${KIND_NAMES[a.kind]} "${a.label}"`;
    const body = a.kind === 'quote' ? `"${clip(a.text, max)}"` : clip(a.text, max);
    const around = a.context ? `\n    Around it: ${clip(a.context, Math.min(max, ATTACH_LIMITS.contextChars))}` : '';
    return `[${i + 1}] ${name}: ${body}${around}`;
  });
  return `Attached:\n${lines.join('\n')}\n\n${question}`;
}
