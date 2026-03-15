import { readdirSync, statSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { removePresence } from './shared.js';

const DEFAULT_MAX_AGE_DAYS = 90;

export function cleanupOldSessions(
  maxAgeDays: number = DEFAULT_MAX_AGE_DAYS,
): { deleted: string[]; errors: string[] } {
  const sessionsDir = join(homedir(), '.meeting-copilot', 'sessions');
  const deleted: string[] = [];
  const errors: string[] = [];

  if (!existsSync(sessionsDir)) {
    return { deleted, errors };
  }

  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  try {
    const entries = readdirSync(sessionsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const sessionPath = join(sessionsDir, entry.name);

      try {
        const stat = statSync(sessionPath);
        if (stat.mtimeMs < cutoffMs) {
          rmSync(sessionPath, { recursive: true, force: true });
          deleted.push(entry.name);
        }
      } catch (error) {
        errors.push(
          `Failed to process ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    errors.push(
      `Failed to read sessions directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { deleted, errors };
}

export function cleanStalePresence(): void {
  const presenceFile = join(homedir(), '.meeting-shared', 'active-session.json');

  try {
    if (!existsSync(presenceFile)) return;

    const raw = readFileSync(presenceFile, 'utf-8');
    const presence = JSON.parse(raw);

    // Check if the PID is still alive
    try {
      process.kill(presence.pid, 0);
      // PID is alive — don't remove
      console.log(`[Cleanup] Shared presence is live (PID ${presence.pid}, app: ${presence.app ?? 'unknown'}, session: ${presence.sessionId ?? 'unknown'})`);
    } catch {
      // PID is dead — stale presence from a previous crash
      console.log(`[Cleanup] Stale presence — PID ${presence.pid} is dead (app: ${presence.app ?? 'unknown'}, started: ${presence.startedAt ?? 'unknown'}), removing`);
      removePresence();
    }
  } catch {
    // Can't read/parse presence file — remove it
    removePresence();
  }
}
