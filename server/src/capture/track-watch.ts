/**
 * Server-side audio health, independent of the app's own watchdog.
 *
 * The app streams both tracks as 100 ms frames for the whole session (Grok's
 * noise gate sits AFTER this, server side), so the server can see for itself
 * when a track stops arriving. On 2026-09-25 the mic engine stopped 28 s into
 * a client meeting and the app's watchdog, which only checked the first
 * buffer, called it healthy; nothing anywhere said the user's side was gone.
 * This is the second opinion: it watches what actually reaches the server.
 *
 *   stalled — no frames for `stallMs` while the other track keeps arriving
 *             (both stopping is the app or the socket going away, which the
 *             connection state already reports)
 *   silent  — mic frames arriving but every sample exact zero for `zeroMs`.
 *             A working mic's noise floor is never exact zero; a denied,
 *             hijacked or wedged one delivers zeros. Not applied to the
 *             meeting track, whose tap reads exact zero whenever the call is
 *             quiet.
 *
 * Pure apart from the injected clock: `frame()` records, `check()` decides and
 * returns only the tracks whose state changed.
 */

export type Track = 'mic' | 'meeting';
export type TrackState = 'ok' | 'stalled' | 'silent';

export interface TrackWatchOptions {
  now?: () => number;
  stallMs?: number;
  zeroMs?: number;
}

interface TrackRecord {
  firstFrameAt: number | null;
  lastFrameAt: number | null;
  lastSignalAt: number | null;
  state: TrackState;
}

const fresh = (): TrackRecord => ({ firstFrameAt: null, lastFrameAt: null, lastSignalAt: null, state: 'ok' });

/** True when any PCM16 sample is non-zero. Stops at the first one. */
export function hasSignal(pcm: Buffer): boolean {
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    if (pcm.readInt16LE(i) !== 0) return true;
  }
  return false;
}

export class TrackWatch {
  private readonly now: () => number;
  private readonly stallMs: number;
  private readonly zeroMs: number;
  private startedAt: number | null = null;
  private tracks: Record<Track, TrackRecord> = { mic: fresh(), meeting: fresh() };

  constructor(opts: TrackWatchOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.stallMs = opts.stallMs ?? 10_000;
    this.zeroMs = opts.zeroMs ?? 15_000;
  }

  start(): void {
    this.startedAt = this.now();
    this.tracks = { mic: fresh(), meeting: fresh() };
  }

  stop(): void {
    this.startedAt = null;
  }

  get active(): boolean {
    return this.startedAt !== null;
  }

  frame(track: Track, pcm: Buffer): void {
    if (this.startedAt === null) return;
    const t = this.now();
    const rec = this.tracks[track];
    rec.firstFrameAt ??= t;
    rec.lastFrameAt = t;
    if (rec.lastSignalAt === null) rec.lastSignalAt = t; // zero-grace starts at the first frame
    if (hasSignal(pcm)) rec.lastSignalAt = t;
  }

  state(track: Track): TrackState {
    return this.tracks[track].state;
  }

  snapshot(): Record<Track, TrackState> {
    return { mic: this.tracks.mic.state, meeting: this.tracks.meeting.state };
  }

  /** Re-judge both tracks; returns the ones whose state changed. */
  check(): Array<{ track: Track; state: TrackState; sinceMs: number }> {
    if (this.startedAt === null) return [];
    const t = this.now();
    const changes: Array<{ track: Track; state: TrackState; sinceMs: number }> = [];
    for (const track of ['mic', 'meeting'] as const) {
      const rec = this.tracks[track];
      const other = this.tracks[track === 'mic' ? 'meeting' : 'mic'];
      const otherAlive = other.lastFrameAt !== null && t - other.lastFrameAt < this.stallMs;
      // Frames stop being evidence once the app itself goes quiet: only a
      // track falling silent while its partner keeps streaming is a verdict.
      const since = rec.lastFrameAt ?? this.startedAt;
      let next: TrackState = 'ok';
      let sinceMs = 0;
      if (otherAlive && t - since >= this.stallMs) {
        next = 'stalled';
        sinceMs = t - since;
      } else if (track === 'mic' && rec.lastFrameAt !== null && t - rec.lastFrameAt < this.stallMs
        && rec.lastSignalAt !== null && t - rec.lastSignalAt >= this.zeroMs) {
        next = 'silent';
        sinceMs = t - rec.lastSignalAt;
      }
      if (next !== rec.state) {
        rec.state = next;
        changes.push({ track, state: next, sinceMs });
      }
    }
    return changes;
  }
}
