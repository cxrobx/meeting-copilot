import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import { pulseFromRow } from '../session/store.js';
import { hideSupersededRollingSummaries } from '../present/replay-actions.js';
import { readSessionTabs, type StagedTab } from '../prep/staged.js';
import { snapshotFile } from '../present/evidence.js';
import { isOpenAiApiAvailable, openaiFastResearchStream } from '../api/openai.js';
import { claudeSuggest } from '../claude-cli.js';
import { MODEL_CONFIG } from '../model-config.js';
import { cxtasksFiler, dueDateToIso, type TaskFiler } from '../cxtasks/client.js';
import {
  cleanTaskFields,
  personTag,
  readTaskDrafts,
  writeTaskDraft,
  type TaskDraft,
  type TaskDraftFields,
} from './tasks.js';
import {
  CHAT_SYSTEM,
  CHAT_NO_TASK_TOOL,
  DRAFT_TASK_TOOL,
  ATTACH_LIMITS,
  buildMeetingSnapshot,
  clip,
  htmlToText,
  normalizeAttachments,
  renderUserTurn,
  type ChatAttachment,
  type ChatCard,
  type MeetingSnapshotInput,
} from './context.js';
import { readChat, writeChat, type ChatMessage, type ChatOrigin } from './store.js';

/**
 * The meeting chat: a thread per session, answered with the whole meeting as
 * context. The user's message is the approval (invariant 3), as with
 * Quick Actions and highlight-to-ask.
 *
 * Turns in one session run in order, so each answer sees the ones before it.
 * Every change goes out as a ChatEvent: the server broadcasts it over the
 * WebSocket (the app, a live dashboard) and the POST that asked streams its
 * own turn back, which is how a replay dashboard (no socket) gets it.
 */

export type ChatEvent =
  | { type: 'chat.message'; sessionId: string; message: ChatMessage }
  // seq counts an answer's deltas from 1: the page that asked gets each one
  // twice (its POST and the socket) and applies it once.
  | { type: 'chat.delta'; sessionId: string; id: string; seq: number; text: string };

export interface ChatAnswerRequest {
  system: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  user: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  label: string;
}

export interface ChatAnswer {
  text: string;
  sources: Array<{ url: string; title: string }>;
  /** The model that answered. */
  via: string;
  /** draft_task calls, as the model gave them (checked by the service). */
  taskDrafts?: TaskDraftFields[];
}

export type ChatAnswerer = (req: ChatAnswerRequest) => Promise<ChatAnswer>;

/** What only the running server knows about the live meeting. */
export interface ChatLiveContext {
  live: boolean;
  /** Agenda items with their covered / not-yet state. */
  agenda: string;
  goals: string;
  /** Reference documents ranked against the question (the prep brief excluded). */
  docs: (hint: string) => string;
}

export interface ChatServiceDeps {
  sessionDir: (sessionId: string) => string;
  liveContext?: (sessionId: string) => ChatLiveContext | null;
  broadcast?: (event: ChatEvent) => void;
  answer?: ChatAnswerer;
  /** Files a confirmed draft into CXTasks (cxtasks/client.ts). */
  fileTask?: TaskFiler;
  /** The repo a meeting's tasks belong to, when it has exactly one project. */
  repoFor?: (sessionId: string) => string | undefined;
  now?: () => number;
  log?: (message: string) => void;
}

export class ChatError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// Earlier turns sent with each question: enough for "and what about the second
// one?", while the meeting itself rides fresh in the system prompt.
const HISTORY_TURNS = 6;
const HISTORY_CHARS = 4_000;

export class ChatService {
  private readonly chains = new Map<string, Promise<unknown>>();
  /** assistant message id → its abort, while queued or running. */
  private readonly inFlight = new Map<string, { sessionId: string; abort: AbortController }>();
  /** Draft ids being filed right now: a second File press is refused. */
  private readonly filing = new Set<string>();
  private readonly deps: Required<Omit<ChatServiceDeps, 'liveContext' | 'repoFor'>> & Pick<ChatServiceDeps, 'liveContext' | 'repoFor'>;

  constructor(deps: ChatServiceDeps) {
    this.deps = {
      broadcast: () => {},
      answer: defaultChatAnswerer(),
      fileTask: cxtasksFiler(),
      now: () => Date.now(),
      log: () => {},
      ...deps,
    };
  }

  private dbPath(sessionId: string): string {
    return join(this.deps.sessionDir(sessionId), 'session.db');
  }

  /** The thread, oldest first. A turn the server lost mid-answer reads as interrupted. */
  thread(sessionId: string): ChatMessage[] {
    const dbPath = this.dbPath(sessionId);
    const drafts = new Map<string, TaskDraft[]>();
    for (const d of readTaskDrafts(dbPath)) {
      const shown = d.state === 'filing' && !this.filing.has(d.id)
        ? { ...d, state: 'error' as const, error: 'The server restarted while filing this. Check CXTasks before filing it again.' }
        : d;
      drafts.set(d.messageId, [...(drafts.get(d.messageId) ?? []), shown]);
    }
    return readChat(dbPath).map((m) => {
      const msg: ChatMessage = m.state === 'streaming' && !this.inFlight.has(m.id)
        ? { ...m, state: 'error', error: 'Interrupted: the server restarted before this answer finished.' }
        : m;
      const own = drafts.get(m.id);
      return own ? { ...msg, drafts: own } : msg;
    });
  }

  /** One message with its drafts, as the thread shows it. */
  private messageWithDrafts(sessionId: string, messageId: string): ChatMessage | undefined {
    return this.thread(sessionId).find((m) => m.id === messageId);
  }

  private emitAll(event: ChatEvent): void {
    try { this.deps.broadcast(event); } catch { /* a dead socket must not stop the work */ }
  }

  /**
   * The pulse's Task button: a draft of one of its items, shown in the chat as
   * a turn of its own. No model is asked; the item already names the step.
   */
  draftFromPulse(req: { sessionId: string; text: unknown; why?: unknown }): ChatMessage {
    const { sessionId } = req;
    const dbPath = this.dbPath(sessionId);
    if (!existsSync(dbPath)) throw new ChatError('That meeting is not here any more.', 404);
    const why = typeof req.why === 'string' ? req.why.trim() : '';
    const fields = cleanTaskFields({ title: req.text, body: why ? `From the meeting pulse: ${why}` : 'From the meeting pulse.' });
    if (!fields) throw new ChatError('That pulse item has no text to make a task from.', 400);
    const now = this.deps.now();
    const message: ChatMessage = {
      id: uuidv4(), role: 'assistant', content: 'A task from the pulse. Check it, then press File.',
      attachments: [], origin: 'dashboard', state: 'done', via: 'pulse', createdAt: now,
    };
    writeChat(dbPath, sessionId, message);
    const draft: TaskDraft = { id: uuidv4(), messageId: message.id, source: 'pulse', ...fields, state: 'draft', createdAt: now };
    writeTaskDraft(dbPath, sessionId, draft);
    const shown = { ...message, drafts: [draft] };
    this.emitAll({ type: 'chat.message', sessionId, message: shown });
    this.deps.log(`task drafted from the pulse`);
    return shown;
  }

  /** The user's File press: their edits, then CXTasks. Resolves with the draft as it ends. */
  async fileDraft(req: { sessionId: string; draftId: unknown; fields?: TaskDraftFields }): Promise<TaskDraft> {
    const { sessionId } = req;
    const dbPath = this.dbPath(sessionId);
    const draft = readTaskDrafts(dbPath).find((d) => d.id === req.draftId);
    if (!draft) throw new ChatError('That draft is not here any more.', 404);
    if (draft.state === 'filed') throw new ChatError(`Already filed as ${draft.taskRef}.`, 409);
    if (this.filing.has(draft.id) || draft.state === 'filing') throw new ChatError('Already filing this one.', 409);
    if (draft.state === 'dismissed') throw new ChatError('That draft was dismissed.', 409);
    const fields = cleanTaskFields({ ...draft, ...(req.fields ?? {}) });
    if (!fields) throw new ChatError('Give the task a title first.', 400);

    this.filing.add(draft.id);
    let current: TaskDraft = { ...draft, ...fields, state: 'filing' };
    delete current.error;
    const save = (d: TaskDraft) => {
      writeTaskDraft(dbPath, sessionId, d);
      const message = this.messageWithDrafts(sessionId, d.messageId);
      if (message) this.emitAll({ type: 'chat.message', sessionId, message });
    };
    try {
      save(current);
      const filed = await this.deps.fileTask({
        title: current.title,
        body: this.taskBody(sessionId, current),
        priority: current.priority,
        dueAt: current.due ? dueDateToIso(current.due) ?? undefined : undefined,
        tags: ['meeting', ...current.people.map(personTag).filter((t) => t.length > 1)],
        repoPath: this.deps.repoFor?.(sessionId),
      });
      current = { ...current, state: 'filed', taskRef: filed.ref, taskId: filed.id };
      this.deps.log(`task filed as ${filed.ref} (from ${current.source})`);
    } catch (err) {
      current = { ...current, state: 'error', error: err instanceof Error ? err.message : String(err) };
      this.deps.log(`task filing failed: ${current.error}`);
    } finally {
      this.filing.delete(draft.id);
    }
    save(current);
    return current;
  }

  dismissDraft(req: { sessionId: string; draftId: unknown }): TaskDraft {
    const { sessionId } = req;
    const dbPath = this.dbPath(sessionId);
    const draft = readTaskDrafts(dbPath).find((d) => d.id === req.draftId);
    if (!draft) throw new ChatError('That draft is not here any more.', 404);
    if (draft.state === 'filed' || draft.state === 'filing' || this.filing.has(draft.id)) {
      throw new ChatError('That one is already filed.', 409);
    }
    const dismissed: TaskDraft = { ...draft, state: 'dismissed' };
    writeTaskDraft(dbPath, sessionId, dismissed);
    const message = this.messageWithDrafts(sessionId, draft.messageId);
    if (message) this.emitAll({ type: 'chat.message', sessionId, message });
    return dismissed;
  }

  /** The draft's notes, then where it came from, so the task reads cold. */
  private taskBody(sessionId: string, d: TaskDraft): string {
    const stored = readStoredMeeting(this.dbPath(sessionId));
    const when = new Date(stored.startedAt ?? d.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const meeting = stored.title ? `"${stored.title}"` : 'a meeting';
    const footer = `From ${meeting} on ${when}, via Meeting Copilot (session \`${sessionId}\`).`;
    return d.body ? `${d.body}\n\n${footer}` : footer;
  }

  busy(sessionId: string): boolean {
    for (const t of this.inFlight.values()) if (t.sessionId === sessionId) return true;
    return false;
  }

  /**
   * Ask. Returns at once with the two messages (the question, and the answer
   * as it starts); `done` settles with the finished answer. Throws ChatError
   * for a question that can't be asked.
   */
  send(
    req: { sessionId: string; text: unknown; attachments?: unknown; origin?: ChatOrigin },
    onEvent?: (event: ChatEvent) => void,
  ): { user: ChatMessage; assistant: ChatMessage; done: Promise<ChatMessage> } {
    const { sessionId } = req;
    const dbPath = this.dbPath(sessionId);
    if (!existsSync(dbPath)) throw new ChatError('That meeting is not here any more.', 404);
    const text = typeof req.text === 'string' ? req.text.trim().slice(0, 4_000) : '';
    const attachments = this.resolveTabs(sessionId, normalizeAttachments(req.attachments));
    if (!text && attachments.length === 0) throw new ChatError('Type a question, or attach something to ask about.', 400);

    const origin: ChatOrigin = req.origin === 'menubar' ? 'menubar' : 'dashboard';
    const now = this.deps.now();
    const user: ChatMessage = { id: uuidv4(), role: 'user', content: text, attachments, origin, state: 'done', createdAt: now };
    const assistant: ChatMessage = { id: uuidv4(), role: 'assistant', content: '', attachments: [], origin, state: 'streaming', via: '', createdAt: now };
    writeChat(dbPath, sessionId, user);
    writeChat(dbPath, sessionId, assistant);

    const emit = (event: ChatEvent) => {
      try { this.deps.broadcast(event); } catch { /* a dead socket must not stop the answer */ }
      try { onEvent?.(event); } catch { /* nor a closed response */ }
    };
    emit({ type: 'chat.message', sessionId, message: user });
    emit({ type: 'chat.message', sessionId, message: assistant });

    const abort = new AbortController();
    this.inFlight.set(assistant.id, { sessionId, abort });
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const done = prev.then(() => this.answerTurn(sessionId, user, assistant, abort.signal, emit));
    this.chains.set(sessionId, done.catch(() => {}));
    return { user, assistant, done };
  }

  /** Stop every queued or running answer in the session. Returns how many. */
  cancel(sessionId: string): number {
    let n = 0;
    for (const t of this.inFlight.values()) {
      if (t.sessionId === sessionId) {
        t.abort.abort();
        n++;
      }
    }
    return n;
  }

  private async answerTurn(
    sessionId: string,
    user: ChatMessage,
    placeholder: ChatMessage,
    signal: AbortSignal,
    emit: (event: ChatEvent) => void,
  ): Promise<ChatMessage> {
    const dbPath = this.dbPath(sessionId);
    let text = '';
    let seq = 0;
    let finished: ChatMessage;
    const started = this.deps.now();
    try {
      if (signal.aborted) throw new Error('Aborted');
      const history = historyFor(readChat(dbPath), user.id);
      const today = new Date(this.deps.now()).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      const system = `${CHAT_SYSTEM}\nToday is ${today}.\n\n${buildMeetingSnapshot(this.snapshotInput(sessionId, user.content))}`;
      const answer = await this.deps.answer({
        system,
        history,
        user: renderUserTurn(user.content, user.attachments),
        signal,
        label: 'chat',
        onDelta: (delta) => {
          if (signal.aborted) return;
          text += delta;
          emit({ type: 'chat.delta', sessionId, id: placeholder.id, seq: ++seq, text: delta });
        },
      });
      // The OpenAI SDK ends an aborted stream quietly instead of throwing, so
      // a stopped answer comes back looking finished. It is not.
      if (signal.aborted) throw new Error('Aborted');
      let content = answer.text || text;
      if (answer.sources.length) {
        const links = answer.sources.slice(0, 4).map((s) => `[${s.title || s.url}](${s.url})`).join(' · ');
        const tail = `\n\n**Sources:** ${links}`;
        content += tail;
        emit({ type: 'chat.delta', sessionId, id: placeholder.id, seq: ++seq, text: tail });
      }
      const drafts: TaskDraft[] = [];
      for (const f of answer.taskDrafts ?? []) {
        const fields = cleanTaskFields(f);
        if (fields) drafts.push({ id: uuidv4(), messageId: placeholder.id, source: 'chat', ...fields, state: 'draft', createdAt: this.deps.now() });
      }
      const fallback = drafts.length ? `Drafted ${drafts.length === 1 ? 'a task' : `${drafts.length} tasks`}. Check, then press File.` : 'No answer came back.';
      finished = { ...placeholder, content: content.trim() || fallback, state: 'done', via: answer.via };
      for (const d of drafts) writeTaskDraft(dbPath, sessionId, d);
      if (drafts.length) finished.drafts = drafts;
      this.deps.log(`answered via=${answer.via} ms=${this.deps.now() - started} chars=${content.length} attachments=${user.attachments.length} origin=${user.origin}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      finished = signal.aborted
        ? { ...placeholder, content: text.trim(), state: 'cancelled' }
        : { ...placeholder, content: text.trim(), state: 'error', error: reason };
      this.deps.log(`${finished.state} after ${this.deps.now() - started}ms: ${reason}`);
    } finally {
      this.inFlight.delete(placeholder.id);
    }
    try {
      writeChat(dbPath, sessionId, finished);
    } catch (err) {
      this.deps.log(`could not save the answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    emit({ type: 'chat.message', sessionId, message: finished });
    return finished;
  }

  /** An evidence tab attachment gets its text from the session's own prep.json, never the client. */
  private resolveTabs(sessionId: string, attachments: ChatAttachment[]): ChatAttachment[] {
    if (!attachments.some((a) => a.kind === 'tab')) return attachments;
    const tabs = readSessionTabs(this.deps.sessionDir(sessionId));
    return attachments.flatMap((a) => {
      if (a.kind !== 'tab') return [a];
      const tab = tabs[a.tabIndex ?? -1];
      return tab ? [{ ...a, label: clip(tab.title, ATTACH_LIMITS.labelChars), text: tabText(tab) }] : [];
    });
  }

  private snapshotInput(sessionId: string, hint: string): MeetingSnapshotInput {
    const dir = this.deps.sessionDir(sessionId);
    const stored = readStoredMeeting(join(dir, 'session.db'));
    const live = this.deps.liveContext?.(sessionId) ?? null;
    let brief = '';
    try {
      const prep = JSON.parse(readFileSync(join(dir, 'prep.json'), 'utf8')) as { brief?: unknown };
      if (typeof prep.brief === 'string') brief = prep.brief;
    } catch {
      /* no prep */
    }
    return {
      ...stored,
      live: live?.live ?? false,
      now: this.deps.now(),
      agenda: live?.agenda || stored.agenda,
      goals: live?.goals ?? '',
      brief,
      docs: live ? live.docs(hint) : '',
      tabs: readSessionTabs(dir).map((t) => ({ title: t.title, url: t.url, note: t.note })),
    };
  }
}

/** An evidence tab as text: what it is, and an html snapshot's words. */
export function tabText(tab: StagedTab, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): string {
  const parts = [tab.url ? `${tab.title} <${tab.url}>` : tab.title];
  if (tab.note) parts.push(`Note: ${tab.note}`);
  const file = snapshotFile(tab);
  if (file?.kind === 'html') {
    try {
      parts.push(`Page text:\n${htmlToText(read(file.path))}`);
    } catch {
      /* unreadable: title and note only */
    }
  } else if (file) {
    parts.push(`(A ${file.kind === 'pdf' ? 'PDF' : 'picture'} snapshot; its contents are not readable here, only its title and note.)`);
  } else {
    parts.push('(A live page; only its title and note are available.)');
  }
  return parts.join('\n').slice(0, ATTACH_LIMITS.textChars);
}

/** Earlier finished exchanges, oldest first, ending before `beforeUserId`. */
export function historyFor(thread: ChatMessage[], beforeUserId: string): ChatAnswerRequest['history'] {
  const end = thread.findIndex((m) => m.id === beforeUserId);
  const earlier = end < 0 ? thread : thread.slice(0, end);
  const pairs: ChatAnswerRequest['history'] = [];
  for (let i = 0; i < earlier.length - 1; i++) {
    const q = earlier[i]!;
    const a = earlier[i + 1]!;
    if (q.role !== 'user' || a.role !== 'assistant' || a.state !== 'done') continue;
    pairs.push(
      { role: 'user', content: renderUserTurn(q.content, q.attachments, 1_500) },
      { role: 'assistant', content: clip(a.content, HISTORY_CHARS) },
    );
  }
  return pairs.slice(-HISTORY_TURNS * 2);
}

/** What a card says, for the snapshot: its text artifacts, else its summary. */
export function cardText(row: { state: string; description?: string; triggerQuote?: string; result?: string | null }): string {
  if (row.state === 'suggested') {
    return [row.description ?? '', row.triggerQuote ? `(Prompted by: "${row.triggerQuote}")` : ''].filter(Boolean).join('\n');
  }
  let result: { summary?: string; artifacts?: Array<{ type: string; content?: string; title?: string }> } | null = null;
  try {
    result = row.result ? JSON.parse(row.result) : null;
  } catch {
    return '';
  }
  if (!result) return row.description ?? '';
  const parts: string[] = [];
  for (const a of result.artifacts ?? []) {
    if (!a.content) continue;
    if (a.type === 'html') parts.push('(An HTML mockup.)');
    else if (a.type === 'markdown' || a.type === 'text' || a.type === 'code') parts.push(a.content);
  }
  return (parts.length ? parts.join('\n\n') : result.summary ?? '').trim();
}

const SKIPPED_CARD_STATES = new Set(['expired', 'cancelled', 'dismissed']);

type StoredMeeting = Pick<MeetingSnapshotInput, 'title' | 'attendees' | 'startedAt' | 'endedAt' | 'agenda' | 'pulse' | 'cards' | 'transcript' | 'summaries'>;

/** Everything the snapshot needs from the session DB. Each table is optional: old meetings lack some. */
export function readStoredMeeting(dbPath: string): StoredMeeting {
  const empty: StoredMeeting = { title: '', attendees: '', startedAt: null, endedAt: null, agenda: '', pulse: null, cards: [], transcript: [], summaries: [] };
  if (!existsSync(dbPath)) return empty;
  const db = new Database(dbPath, { readonly: true });
  const all = <T>(sql: string): T[] => {
    try {
      return db.prepare(sql).all() as T[];
    } catch {
      return [];
    }
  };
  try {
    const session = all<Record<string, any>>('SELECT * FROM session LIMIT 1')[0];
    const pulseRow = all<Record<string, any>>('SELECT * FROM pulse ORDER BY createdAt DESC LIMIT 1')[0];
    const actions = hideSupersededRollingSummaries(
      all<{ type: string; title: string; description: string; triggerQuote: string; state: string; params: string | null; result: string | null }>(
        'SELECT type, title, description, triggerQuote, state, params, result FROM action ORDER BY createdAt ASC',
      ),
    );
    const cards: ChatCard[] = actions
      .filter((a) => !SKIPPED_CARD_STATES.has(a.state))
      .map((a) => ({ title: a.title, type: a.type, state: a.state, text: cardText(a) }));
    const pulse = pulseRow ? pulseFromRow(pulseRow) : null;
    return {
      title: session?.title ?? '',
      attendees: session?.attendees ?? '',
      startedAt: session?.startedAt ?? null,
      endedAt: session?.endedAt ?? null,
      agenda: session?.agenda ?? '',
      pulse: pulse && {
        status: pulse.status,
        read: pulse.read,
        escalations: pulse.escalations,
        closeOut: pulse.closeOut,
        missed: pulse.missed,
        minutesIn: pulse.minutesIn,
      },
      cards,
      transcript: all('SELECT label, text, timestamp FROM transcript ORDER BY timestamp ASC'),
      summaries: all('SELECT summary, windowStart, windowEnd FROM context_summary ORDER BY createdAt ASC'),
    };
  } finally {
    db.close();
  }
}

/**
 * gpt-6-luna with web search (metered, like fast research), and the
 * subscription CLI when the API is off, or fails before its first word (the
 * budget ceiling, a network error). A failure mid-answer is reported, not
 * retried: half an answer followed by a different whole one reads worse.
 */
export function defaultChatAnswerer(log: (message: string) => void = () => {}): ChatAnswerer {
  return async (req) => {
    let spoke = false;
    const onDelta = (t: string) => {
      spoke = true;
      req.onDelta(t);
    };
    if (isOpenAiApiAvailable()) {
      try {
        const r = await openaiFastResearchStream({
          systemPrompt: req.system,
          history: req.history,
          userContent: req.user,
          model: MODEL_CONFIG.chat,
          signal: req.signal,
          onDelta,
          label: req.label,
          functions: [DRAFT_TASK_TOOL],
        });
        const taskDrafts = (r.calls ?? []).filter((c) => c.name === DRAFT_TASK_TOOL.name).map((c) => c.arguments as TaskDraftFields);
        return { text: r.text, sources: r.sources, via: MODEL_CONFIG.chat, ...(taskDrafts.length ? { taskDrafts } : {}) };
      } catch (err) {
        if (req.signal.aborted || spoke) throw err;
        log(`OpenAI failed before answering, trying the subscription CLI: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // The CLI takes one prompt, so earlier turns go in as a transcript of the chat.
    const earlier = req.history.length
      ? `Our conversation so far:\n${req.history.map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content}`).join('\n\n')}\n\nNow:\n`
      : '';
    const text = await claudeSuggest(`${earlier}${req.user}`, `${req.system}\n\n${CHAT_NO_TASK_TOOL}`, req.signal, ['WebSearch', 'WebFetch'], {
      onDelta,
      model: MODEL_CONFIG.worker,
      cold: true,
      maxTurns: 6,
    });
    return { text, sources: [], via: MODEL_CONFIG.worker };
  };
}
