import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export class EventLogger {
  private filePath: string;

  constructor(sessionDir: string) {
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    this.filePath = join(sessionDir, 'events.jsonl');
  }

  log(event: string, data?: Record<string, any>): void {
    const entry = {
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
      event,
      ...data,
    };

    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (error) {
      // Silently fail - event logging should not break the app
      console.error(
        `[EventLogger] Failed to write event ${event}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
