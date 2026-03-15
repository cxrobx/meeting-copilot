import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { TranscriptSegment } from '../transcription/types.js';

const BASE_DIR = join(homedir(), '.meeting-copilot', 'sessions');

export interface SessionRecord {
  id: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  state: 'active' | 'paused' | 'ended';
}

export interface TranscriptRecord {
  id: string;
  sessionId: string;
  text: string;
  source: string;
  label: string;
  timestamp: number;
  duration: number;
  wordCount: number;
  redacted: boolean;
}

export interface ActionRecord {
  id: string;
  sessionId: string;
  type: string;
  title: string;
  description: string;
  triggerQuote: string;
  state: string;
  params: string; // JSON
  result: string | null; // JSON
  createdAt: number;
  approvedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
}

export interface ContextSummaryRecord {
  id: string;
  sessionId: string;
  summary: string;
  windowStart: number;
  windowEnd: number;
  createdAt: number;
}

export class SessionStore {
  private db: Database.Database;
  private sessionId: string;
  private sessionDir: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? uuidv4();
    this.sessionDir = join(BASE_DIR, this.sessionId);

    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }

    const dbPath = join(this.sessionDir, 'session.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.initTables();
  }

  get id(): string {
    return this.sessionId;
  }

  get directory(): string {
    return this.sessionDir;
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        projectNames TEXT NOT NULL DEFAULT '[]',
        agenda TEXT NOT NULL DEFAULT '',
        attendees TEXT NOT NULL DEFAULT '',
        startedAt INTEGER NOT NULL,
        endedAt INTEGER,
        state TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS transcript (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        label TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        duration REAL NOT NULL DEFAULT 0,
        wordCount INTEGER NOT NULL DEFAULT 0,
        redacted INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (sessionId) REFERENCES session(id)
      );

      CREATE TABLE IF NOT EXISTS action (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        triggerQuote TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        result TEXT,
        createdAt INTEGER NOT NULL,
        approvedAt INTEGER,
        startedAt INTEGER,
        completedAt INTEGER,
        FOREIGN KEY (sessionId) REFERENCES session(id)
      );

      CREATE TABLE IF NOT EXISTS context_summary (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        summary TEXT NOT NULL,
        windowStart INTEGER NOT NULL,
        windowEnd INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (sessionId) REFERENCES session(id)
      );

      CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript(sessionId);
      CREATE INDEX IF NOT EXISTS idx_transcript_timestamp ON transcript(timestamp);
      CREATE INDEX IF NOT EXISTS idx_action_session ON action(sessionId);
      CREATE INDEX IF NOT EXISTS idx_action_state ON action(state);
      CREATE INDEX IF NOT EXISTS idx_context_summary_session ON context_summary(sessionId);
    `);
  }

  createSession(title: string = '', projectNames: string[] = [], agenda?: string, attendees?: string): SessionRecord {
    const now = Date.now();
    const stmt = this.db.prepare(
      'INSERT INTO session (id, title, projectNames, agenda, attendees, startedAt, state) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    stmt.run(this.sessionId, title, JSON.stringify(projectNames), agenda ?? '', attendees ?? '', now, 'active');
    return {
      id: this.sessionId,
      title,
      startedAt: now,
      endedAt: null,
      state: 'active',
    };
  }

  updateState(state: 'active' | 'paused' | 'ended'): void {
    const updates: Record<string, any> = { state };
    if (state === 'ended') {
      updates.endedAt = Date.now();
    }

    const stmt = this.db.prepare(
      'UPDATE session SET state = ?, endedAt = ? WHERE id = ?',
    );
    stmt.run(state, state === 'ended' ? Date.now() : null, this.sessionId);
  }

  addTranscript(segment: TranscriptSegment): void {
    const stmt = this.db.prepare(
      `INSERT INTO transcript (id, sessionId, text, source, label, timestamp, duration, wordCount, redacted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      segment.id,
      this.sessionId,
      segment.text,
      segment.source,
      segment.label,
      segment.timestamp,
      segment.duration,
      segment.wordCount,
      0,
    );
  }

  addAction(action: {
    id: string;
    type: string;
    title: string;
    description: string;
    triggerQuote: string;
    state: string;
    params: Record<string, any>;
    createdAt: number;
  }): void {
    const stmt = this.db.prepare(
      `INSERT INTO action (id, sessionId, type, title, description, triggerQuote, state, params, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      action.id,
      this.sessionId,
      action.type,
      action.title,
      action.description,
      action.triggerQuote,
      action.state,
      JSON.stringify(action.params),
      action.createdAt,
    );
  }

  updateAction(
    actionId: string,
    updates: {
      state?: string;
      result?: any;
      approvedAt?: number;
      startedAt?: number;
      completedAt?: number;
    },
  ): void {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.state !== undefined) {
      fields.push('state = ?');
      values.push(updates.state);
    }
    if (updates.result !== undefined) {
      fields.push('result = ?');
      values.push(JSON.stringify(updates.result));
    }
    if (updates.approvedAt !== undefined) {
      fields.push('approvedAt = ?');
      values.push(updates.approvedAt);
    }
    if (updates.startedAt !== undefined) {
      fields.push('startedAt = ?');
      values.push(updates.startedAt);
    }
    if (updates.completedAt !== undefined) {
      fields.push('completedAt = ?');
      values.push(updates.completedAt);
    }

    if (fields.length === 0) return;

    values.push(actionId);
    const stmt = this.db.prepare(
      `UPDATE action SET ${fields.join(', ')} WHERE id = ?`,
    );
    stmt.run(...values);
  }

  getTranscript(): TranscriptRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM transcript WHERE sessionId = ? ORDER BY timestamp ASC',
    );
    return stmt.all(this.sessionId) as TranscriptRecord[];
  }

  getActions(): ActionRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM action WHERE sessionId = ? ORDER BY createdAt ASC',
    );
    return stmt.all(this.sessionId) as ActionRecord[];
  }

  getSummaries(): ContextSummaryRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM context_summary WHERE sessionId = ? ORDER BY createdAt ASC',
    );
    return stmt.all(this.sessionId) as ContextSummaryRecord[];
  }

  addContextSummary(summary: {
    summary: string;
    windowStart: number;
    windowEnd: number;
  }): void {
    const stmt = this.db.prepare(
      `INSERT INTO context_summary (id, sessionId, summary, windowStart, windowEnd, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      uuidv4(),
      this.sessionId,
      summary.summary,
      summary.windowStart,
      summary.windowEnd,
      Date.now(),
    );
  }

  getSession(): SessionRecord | undefined {
    const stmt = this.db.prepare('SELECT * FROM session WHERE id = ?');
    return stmt.get(this.sessionId) as SessionRecord | undefined;
  }

  deleteSession(): void {
    this.db.prepare('DELETE FROM context_summary WHERE sessionId = ?').run(this.sessionId);
    this.db.prepare('DELETE FROM action WHERE sessionId = ?').run(this.sessionId);
    this.db.prepare('DELETE FROM transcript WHERE sessionId = ?').run(this.sessionId);
    this.db.prepare('DELETE FROM session WHERE id = ?').run(this.sessionId);
  }

  exportMarkdown(): string {
    const session = this.getSession();
    const transcript = this.getTranscript();
    const actions = this.getActions();

    const lines: string[] = [];
    lines.push(`# Meeting: ${session?.title || 'Untitled'}`);
    lines.push(`**Date:** ${new Date(session?.startedAt ?? Date.now()).toISOString()}`);
    lines.push('');
    lines.push('## Transcript');
    lines.push('');

    for (const seg of transcript) {
      if (seg.redacted) {
        lines.push(`${seg.label} [REDACTED]`);
      } else {
        lines.push(`${seg.label} ${seg.text}`);
      }
    }

    lines.push('');
    lines.push('## Actions');
    lines.push('');

    for (const action of actions) {
      const result = action.result ? JSON.parse(action.result) : null;
      lines.push(`### ${action.title}`);
      lines.push(`- **Type:** ${action.type}`);
      lines.push(`- **State:** ${action.state}`);
      lines.push(`- **Trigger:** "${action.triggerQuote}"`);
      if (result?.summary) {
        lines.push(`- **Result:** ${result.summary}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  exportJSON(): object {
    return {
      session: this.getSession(),
      transcript: this.getTranscript(),
      actions: this.getActions(),
      summaries: this.getSummaries(),
    };
  }

  writeManifest(): void {
    const session = this.getSession();
    const actions = this.getActions();
    const manifest = {
      version: 1,
      sessionId: this.sessionId,
      title: session?.title ?? '',
      startedAt: session?.startedAt ? new Date(session.startedAt).toISOString() : null,
      endedAt: session?.endedAt ? new Date(session.endedAt).toISOString() : null,
      state: session?.state ?? 'unknown',
      transcriptionSource: 'whisper-local',
      transcriptSegments: this.getTranscript().length,
      actions: actions.map((a) => ({
        id: a.id,
        type: a.type,
        title: a.title,
        state: a.state,
      })),
      createdAt: new Date().toISOString(),
    };
    const manifestPath = join(this.sessionDir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  close(): void {
    // Write manifest before closing for session interoperability
    try {
      this.writeManifest();
    } catch {
      // Best effort — don't block shutdown
    }
    this.db.close();
  }
}
