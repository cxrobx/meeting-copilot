import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { ChatAttachment } from './context.js';

/**
 * The meeting chat's thread, kept in the session's own database (invariant 2:
 * one meeting, one DB), so it reloads with the meeting and goes when it goes.
 * Each call opens its own connection: the live session's SessionStore holds
 * another on the same WAL file, and a stored meeting can be chatted with
 * after the app has closed it.
 */

export type ChatRole = 'user' | 'assistant';
export type ChatOrigin = 'dashboard' | 'menubar';
export type ChatState = 'streaming' | 'done' | 'error' | 'cancelled';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  attachments: ChatAttachment[];
  origin: ChatOrigin;
  state: ChatState;
  error?: string;
  /** Which model answered, for an assistant turn ('' for the user's). */
  via?: string;
  createdAt: number;
}

export const CHAT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS chat_message (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    origin TEXT NOT NULL DEFAULT 'dashboard',
    state TEXT NOT NULL DEFAULT 'done',
    error TEXT,
    via TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_message_session ON chat_message(sessionId, createdAt);
`;

function fromRow(row: Record<string, any>): ChatMessage {
  let attachments: ChatAttachment[] = [];
  try {
    const parsed = JSON.parse(String(row.attachments ?? '[]'));
    if (Array.isArray(parsed)) attachments = parsed;
  } catch {
    /* a bad row keeps its text */
  }
  const m: ChatMessage = {
    id: row.id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content ?? '',
    attachments,
    origin: row.origin === 'menubar' ? 'menubar' : 'dashboard',
    state: row.state,
    via: row.via ?? '',
    createdAt: row.createdAt,
  };
  if (row.error) m.error = row.error;
  return m;
}

/** The thread, oldest first; [] for a session with no chat (or no DB). */
export function readChat(dbPath: string): ChatMessage[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_message'").get();
    if (!table) return [];
    // Insertion order is thread order: a question, then its answer's row
    // (written at once and updated in place), even when two share a millisecond.
    const rows = db.prepare('SELECT * FROM chat_message ORDER BY rowid ASC').all() as Array<Record<string, any>>;
    return rows.map(fromRow);
  } finally {
    db.close();
  }
}

/** Insert or replace one message (a streamed answer is written when it ends). */
export function writeChat(dbPath: string, sessionId: string, m: ChatMessage): void {
  const db = new Database(dbPath);
  try {
    db.pragma('busy_timeout = 3000');
    db.exec(CHAT_TABLE_SQL);
    db.prepare(
      `INSERT INTO chat_message (id, sessionId, role, content, attachments, origin, state, error, via, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET content = excluded.content, state = excluded.state,
         error = excluded.error, via = excluded.via`,
    ).run(
      m.id, sessionId, m.role, m.content, JSON.stringify(m.attachments ?? []), m.origin, m.state,
      m.error ?? null, m.via ?? '', m.createdAt,
    );
  } finally {
    db.close();
  }
}
