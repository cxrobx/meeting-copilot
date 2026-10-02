import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';

/**
 * Task drafts in the meeting chat. The chat model (its draft_task tool) or the
 * pulse's Task button proposes one; nothing reaches CXTasks until the user
 * presses File on it (invariant 3). Kept in the session's own database next
 * to the chat it belongs to, so a filed draft still reads "Filed T232" when
 * the meeting is reopened.
 */

export type TaskDraftState = 'draft' | 'filing' | 'filed' | 'dismissed' | 'error';
export type TaskDraftSource = 'chat' | 'pulse';

export interface TaskDraft {
  id: string;
  /** The chat message it is shown under. */
  messageId: string;
  source: TaskDraftSource;
  title: string;
  body: string;
  /** 0 (most urgent) to 3, as CXTasks has it. */
  priority: number;
  /** YYYY-MM-DD, or '' for no deadline. */
  due: string;
  /** People named in it, without the @. */
  people: string[];
  state: TaskDraftState;
  taskRef?: string;
  taskId?: string;
  error?: string;
  createdAt: number;
}

/** What a draft can be made or edited from, before checking. */
export interface TaskDraftFields {
  title?: unknown;
  body?: unknown;
  notes?: unknown;
  priority?: unknown;
  due?: unknown;
  people?: unknown;
}

export const TASK_LIMITS = { titleChars: 200, bodyChars: 4_000, people: 6, personChars: 40 };
export const DEFAULT_TASK_PRIORITY = 2;

/** Checked fields, or null when there is no title. */
export function cleanTaskFields(f: TaskDraftFields): Pick<TaskDraft, 'title' | 'body' | 'priority' | 'due' | 'people'> | null {
  const title = typeof f.title === 'string' ? f.title.replace(/\s+/g, ' ').trim().slice(0, TASK_LIMITS.titleChars) : '';
  if (!title) return null;
  const rawBody = typeof f.body === 'string' ? f.body : typeof f.notes === 'string' ? f.notes : '';
  const n = typeof f.priority === 'number' ? f.priority : typeof f.priority === 'string' && f.priority.trim() !== '' ? Number(f.priority) : NaN;
  const due = typeof f.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.due.trim()) ? f.due.trim() : '';
  const people = (Array.isArray(f.people) ? f.people : [])
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.replace(/^@/, '').replace(/\s+/g, ' ').trim().slice(0, TASK_LIMITS.personChars))
    .filter((p, i, all) => p && all.indexOf(p) === i)
    .slice(0, TASK_LIMITS.people);
  return {
    title,
    body: rawBody.trim().slice(0, TASK_LIMITS.bodyChars),
    priority: Number.isInteger(n) && n >= 0 && n <= 3 ? n : DEFAULT_TASK_PRIORITY,
    due,
    people,
  };
}

/** A person as a CXTasks tag: "@rory", "@mary-ann". */
export function personTag(name: string): string {
  return `@${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

export const TASK_DRAFT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS task_draft (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    messageId TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'chat',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 2,
    due TEXT NOT NULL DEFAULT '',
    people TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'draft',
    taskRef TEXT,
    taskId TEXT,
    error TEXT,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_draft_message ON task_draft(messageId);
`;

function fromRow(row: Record<string, any>): TaskDraft {
  let people: string[] = [];
  try {
    const parsed = JSON.parse(String(row.people ?? '[]'));
    if (Array.isArray(parsed)) people = parsed.filter((p) => typeof p === 'string');
  } catch {
    /* keep the rest */
  }
  const d: TaskDraft = {
    id: row.id,
    messageId: row.messageId,
    source: row.source === 'pulse' ? 'pulse' : 'chat',
    title: row.title ?? '',
    body: row.body ?? '',
    priority: Number(row.priority ?? DEFAULT_TASK_PRIORITY),
    due: row.due ?? '',
    people,
    state: row.state,
    createdAt: row.createdAt,
  };
  if (row.taskRef) d.taskRef = row.taskRef;
  if (row.taskId) d.taskId = row.taskId;
  if (row.error) d.error = row.error;
  return d;
}

/** Every draft in the session, oldest first; [] when there are none. */
export function readTaskDrafts(dbPath: string): TaskDraft[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_draft'").get();
    if (!table) return [];
    return (db.prepare('SELECT * FROM task_draft ORDER BY rowid ASC').all() as Array<Record<string, any>>).map(fromRow);
  } finally {
    db.close();
  }
}

export function writeTaskDraft(dbPath: string, sessionId: string, d: TaskDraft): void {
  const db = new Database(dbPath);
  try {
    db.pragma('busy_timeout = 3000');
    db.exec(TASK_DRAFT_TABLE_SQL);
    db.prepare(
      `INSERT INTO task_draft (id, sessionId, messageId, source, title, body, priority, due, people, state, taskRef, taskId, error, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, priority = excluded.priority,
         due = excluded.due, people = excluded.people, state = excluded.state, taskRef = excluded.taskRef,
         taskId = excluded.taskId, error = excluded.error`,
    ).run(
      d.id, sessionId, d.messageId, d.source, d.title, d.body, d.priority, d.due, JSON.stringify(d.people), d.state,
      d.taskRef ?? null, d.taskId ?? null, d.error ?? null, d.createdAt,
    );
  } finally {
    db.close();
  }
}
