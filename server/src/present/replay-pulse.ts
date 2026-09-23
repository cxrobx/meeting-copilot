import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { pulseFromRow, type PulseRecord } from '../session/store.js';

/** The meeting pulses a stored session produced, oldest first ([] before 2026-09-22). */
export function readStoredPulses(sessionDir: string): PulseRecord[] {
  const dbPath = join(sessionDir, 'session.db');
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pulse'").get();
    if (!hasTable) return [];
    const rows = db.prepare('SELECT * FROM pulse ORDER BY createdAt ASC').all() as Array<Record<string, any>>;
    return rows.map(pulseFromRow);
  } finally {
    db.close();
  }
}
