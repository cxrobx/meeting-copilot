import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export interface StoredCoachCard {
  id: string;
  incidentType: string;
  kind: string;
  priority: number;
  confidence: number;
  headline: string;
  /** Empty for cards recovered from the event log, which never kept it. */
  phrasing: string;
  why: string;
  createdAt: number;
}

/** Sessions are UUID directories; anything else never reaches the filesystem. */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The coach cards a stored session showed, oldest first.
 *
 * `coach_suggestion` holds them from 2026-09-22 on. Older sessions only have
 * the event log's `coach.suggestion` lines — headline, kind and time, but not
 * the suggested wording — which is still enough to see what the coach flagged
 * and when (the 09-21 call's 12 cards are recoverable this way).
 */
export function readStoredCoach(sessionDir: string): StoredCoachCard[] {
  const dbPath = join(sessionDir, 'session.db');
  if (existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const hasTable = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coach_suggestion'",
      ).get();
      if (hasTable) {
        const rows = db.prepare(
          'SELECT id, incidentType, kind, priority, confidence, headline, phrasing, why, createdAt FROM coach_suggestion ORDER BY createdAt ASC',
        ).all() as StoredCoachCard[];
        if (rows.length > 0) return rows;
      }
    } finally {
      db.close();
    }
  }

  const eventsPath = join(sessionDir, 'events.jsonl');
  if (!existsSync(eventsPath)) return [];
  const cards: StoredCoachCard[] = [];
  for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line.includes('"coach.suggestion"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.event !== 'coach.suggestion' || typeof e.headline !== 'string') continue;
      cards.push({
        id: typeof e.id === 'string' ? e.id : `event-${e.timestamp}-${cards.length}`,
        incidentType: String(e.incidentType ?? 'none'),
        kind: String(e.kind ?? 'address'),
        priority: Number(e.priority ?? 0),
        confidence: Number(e.confidence ?? 0),
        headline: e.headline,
        phrasing: typeof e.phrasing === 'string' ? e.phrasing : '',
        why: typeof e.why === 'string' ? e.why : '',
        createdAt: Number(e.timestamp),
      });
    } catch {
      /* a torn line is skipped, not fatal */
    }
  }
  return cards;
}
