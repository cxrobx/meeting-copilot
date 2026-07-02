import { writeFileSync, appendFileSync, unlinkSync, mkdirSync, existsSync, openSync, writeSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TranscriptSegment } from '../transcription/types.js';
import { CHUNK_DURATION_SECONDS } from '../audio/chunkConfig.js';

const SHARED_DIR = join(homedir(), '.meeting-shared');
const PRESENCE_FILE = join(SHARED_DIR, 'active-session.json');
const TRANSCRIPT_FILE = join(SHARED_DIR, 'live-transcript.jsonl');

// Tracks session start time for converting epoch-ms timestamps to relative seconds
let sessionStartMs = 0;

// When false, no shared files are written
let sharingEnabled = true;

interface SharedPresence {
  app: string;
  pid: number;
  sessionId: string;
  startedAt: string;
  transcriptFile: string;
}

export function isSharingEnabled(): boolean {
  return sharingEnabled;
}

export function setSharingEnabled(enabled: boolean): void {
  sharingEnabled = enabled;
}

export function writePresence(sessionId: string): void {
  if (!sharingEnabled) return;

  sessionStartMs = Date.now();

  try {
    if (!existsSync(SHARED_DIR)) {
      mkdirSync(SHARED_DIR, { recursive: true });
    }

    const presence: SharedPresence = {
      app: 'meeting-copilot',
      pid: process.pid,
      sessionId,
      startedAt: new Date().toISOString(),
      transcriptFile: TRANSCRIPT_FILE,
    };

    writeFileSync(PRESENCE_FILE, JSON.stringify(presence, null, 2), 'utf-8');
    console.log('[SharedTranscript] Presence written');
  } catch (error) {
    console.warn(
      '[SharedTranscript] Failed to write presence:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function removePresence(): void {
  try {
    if (existsSync(PRESENCE_FILE)) {
      unlinkSync(PRESENCE_FILE);
    }
  } catch {
    // Silent — best effort cleanup
  }

  try {
    if (existsSync(TRANSCRIPT_FILE)) {
      unlinkSync(TRANSCRIPT_FILE);
    }
  } catch {
    // Silent — best effort cleanup
  }

  console.log('[SharedTranscript] Presence removed');
}

export function appendTranscript(segment: TranscriptSegment): void {
  if (!sharingEnabled) return;

  try {
    // Prefer the Swift-stamped capture time over segment.timestamp (which is
    // server-finalized, so it lags by chunk wait + whisper decode — 1–4s).
    // notes4chris and the CSV/MD exports want TRUE audio time: when the words
    // were spoken. Fallbacks: captureEndedAt - audioDurationSec, then the old
    // server-finalized timestamp.
    let absoluteMs: number | null = null;
    if (segment.captureStartedAt) {
      const parsed = Date.parse(segment.captureStartedAt);
      if (!Number.isNaN(parsed)) absoluteMs = parsed;
    }
    if (absoluteMs === null && segment.captureEndedAt && segment.audioDurationSec) {
      const parsed = Date.parse(segment.captureEndedAt);
      if (!Number.isNaN(parsed)) {
        absoluteMs = parsed - segment.audioDurationSec * 1000;
      }
    }
    if (absoluteMs === null) {
      absoluteMs = segment.timestamp;
    }

    const relativeSeconds = sessionStartMs > 0
      ? (absoluteMs - sessionStartMs) / 1000
      : 0;

    // Prefer the real audio duration from the segment; fall back to the
    // fixed chunk constant if an older producer sent 0 / undefined.
    const audioDuration = segment.audioDurationSec || CHUNK_DURATION_SECONDS;

    const line = JSON.stringify({
      id: segment.id,
      text: segment.text,
      source: segment.source,
      label: segment.label,
      timestamp: relativeSeconds,
      duration: audioDuration,
      wordCount: segment.wordCount,
    }) + '\n';

    // Use O_APPEND | O_WRONLY for atomic append (POSIX guarantees atomicity for writes < PIPE_BUF)
    const fd = openSync(TRANSCRIPT_FILE, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o644);
    try {
      writeSync(fd, line, null, 'utf-8');
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    console.warn(
      '[SharedTranscript] Failed to append transcript:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

