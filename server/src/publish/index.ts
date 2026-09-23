import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ViewableAction } from '../present/view-page.js';
import { PENDING_NOTE } from '../workers/deep-follow-up.js';
import { isSessionId } from '../session/ids.js';
import type { PolishedPage } from './polish.js';
import { newShareKey, shareUrl, type Uploader } from './uploader.js';

/**
 * Publish a card as a public link, one click from the dashboard.
 *
 * Runs outside the worker slots, like the deep follow-up, so a publish never
 * queues an approved card behind it. One job at a time: publishing is rare,
 * and a second click while one runs is far more likely a double-click than
 * a second card.
 *
 * Every link is written twice: into the session's own `published.json`
 * (session isolation, and what the dashboard reads back on load) and onto the
 * global append-only `~/.meeting-copilot/published.jsonl`, so every live link
 * can be found and revoked later without opening each session.
 */

export type PublishPhase = 'polishing' | 'uploading' | 'done' | 'failed' | 'revoked';

export interface PublishStateMessage {
  type: 'publish.state';
  actionId: string;
  phase: PublishPhase;
  url?: string;
  error?: string;
}

export interface PublishRecord {
  actionId: string;
  key: string;
  url: string;
  title: string;
  via: PolishedPage['via'];
  at: number;
  revokedAt?: number;
}

export interface PublishDeps {
  find(actionId: string, sessionId: string | undefined): { action: ViewableAction; sessionId?: string } | null;
  polish(action: ViewableAction, signal: AbortSignal): Promise<PolishedPage>;
  uploader: Uploader;
  broadcast(message: PublishStateMessage): void;
  newKey?: () => string;
  log?: (message: string) => void;
}

export type StartResult =
  | { ok: true; status: 202 }
  | { ok: true; status: 200; record: PublishRecord }
  | { ok: false; status: 400 | 404 | 409; error: string };

function root(): string {
  return join(homedir(), '.meeting-copilot');
}

function sessionDir(sessionId: string): string {
  return join(root(), 'sessions', sessionId);
}

export function readPublished(sessionId: string): Record<string, PublishRecord> {
  if (!isSessionId(sessionId)) return {};
  try {
    return JSON.parse(readFileSync(join(sessionDir(sessionId), 'published.json'), 'utf8'));
  } catch {
    return {};
  }
}

function writePublished(sessionId: string, records: Record<string, PublishRecord>): void {
  const file = join(sessionDir(sessionId), 'published.json');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2));
  renameSync(tmp, file);
}

function appendLedger(entry: Record<string, unknown>): void {
  mkdirSync(root(), { recursive: true });
  appendFileSync(join(root(), 'published.jsonl'), JSON.stringify(entry) + '\n', { flag: 'a' });
}

export class PublishJobs {
  private running: { actionId: string; controller: AbortController } | null = null;
  /** The last state each card reached, for a page with no WebSocket (replay) to poll. */
  private lastState = new Map<string, PublishStateMessage>();

  constructor(private deps: PublishDeps) {}

  private say(message: PublishStateMessage): void {
    this.lastState.set(message.actionId, message);
    this.deps.broadcast(message);
  }

  /** Latest in-process state per card, since this server started. */
  states(): Record<string, PublishStateMessage> {
    return Object.fromEntries(this.lastState);
  }

  get busy(): string | null {
    return this.running?.actionId ?? null;
  }

  /** The live link for a card, if it has one. */
  current(actionId: string, sessionId: string | undefined): PublishRecord | null {
    if (!sessionId) return null;
    const record = readPublished(sessionId)[actionId];
    return record && !record.revokedAt ? record : null;
  }

  start(actionId: string, requestedSession: string | undefined): StartResult {
    const found = this.deps.find(actionId, requestedSession);
    if (!found) return { ok: false, status: 404, error: 'That card is not here any more.' };
    const sessionId = found.sessionId;
    if (!isSessionId(sessionId) || !existsSync(sessionDir(sessionId))) {
      return { ok: false, status: 409, error: 'This card has no session to file the link under.' };
    }
    const existing = this.current(actionId, sessionId);
    if (existing) return { ok: true, status: 200, record: existing };
    if (this.running) {
      return { ok: false, status: 409, error: this.running.actionId === actionId ? 'Already publishing this card.' : 'Another card is publishing; try again in a moment.' };
    }
    const markdown = found.action.result?.artifacts?.map((a) => a.content).join('\n') ?? '';
    if (markdown.includes(PENDING_NOTE)) {
      return { ok: false, status: 409, error: 'Deep research is still adding to this card; publish once it lands.' };
    }
    if (!found.action.result?.artifacts?.length) return { ok: false, status: 400, error: 'This card has nothing to publish.' };

    const controller = new AbortController();
    this.running = { actionId, controller };
    void this.run(found.action, sessionId, controller).finally(() => {
      if (this.running?.controller === controller) this.running = null;
    });
    return { ok: true, status: 202 };
  }

  private async run(action: ViewableAction, sessionId: string, controller: AbortController): Promise<void> {
    const say = (phase: PublishPhase, extra: Partial<PublishStateMessage> = {}) =>
      this.say({ type: 'publish.state', actionId: action.id, phase, ...extra });
    try {
      say('polishing');
      const page = await this.deps.polish(action, controller.signal);
      if (page.reason) this.deps.log?.(`${action.id}: using the reader page (${page.reason})`);
      say('uploading');
      const key = (this.deps.newKey ?? newShareKey)();
      await this.deps.uploader.put(key, page.html, controller.signal);
      const record: PublishRecord = { actionId: action.id, key, url: shareUrl(key), title: action.title, via: page.via, at: Date.now() };
      const records = readPublished(sessionId);
      records[action.id] = record;
      writePublished(sessionId, records);
      appendLedger({ event: 'published', ...record, sessionId });
      this.deps.log?.(`${action.id}: published (${page.via})`);
      say('done', { url: record.url });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log?.(`${action.id}: publish failed: ${message}`);
      say('failed', { error: message });
    }
  }

  async revoke(actionId: string, requestedSession: string | undefined): Promise<{ ok: true } | { ok: false; status: 404 | 502; error: string }> {
    const sessionId = requestedSession ?? this.deps.find(actionId, undefined)?.sessionId;
    const record = this.current(actionId, sessionId);
    if (!sessionId || !record) return { ok: false, status: 404, error: 'This card has no live link.' };
    try {
      await this.deps.uploader.remove(record.key);
    } catch (error) {
      return { ok: false, status: 502, error: `Could not take the page down: ${error instanceof Error ? error.message : String(error)}` };
    }
    const records = readPublished(sessionId);
    records[actionId] = { ...record, revokedAt: Date.now() };
    writePublished(sessionId, records);
    appendLedger({ event: 'revoked', key: record.key, url: record.url, actionId, sessionId, at: Date.now() });
    this.say({ type: 'publish.state', actionId, phase: 'revoked' });
    return { ok: true };
  }
}
