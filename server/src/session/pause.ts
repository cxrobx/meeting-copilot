/**
 * Meeting pause: the server's record of when a live session was paused.
 *
 * Paused means no audio is transcribed or streamed (nothing leaves the Mac,
 * nothing is billed), the capture watchdog stands down, and the timer reads
 * meeting time without the pauses. The app keeps its capture running so
 * Resume is instant and cannot fail; it only stops sending.
 *
 * Pure apart from the injected clock, so the arithmetic is testable.
 */

export interface PauseSpan {
  startedAt: number;
  endedAt: number;
}

/** What `session.paused` carries to every client. */
export interface PauseSnapshot {
  paused: boolean;
  /** Epoch ms the current pause began; null while running. */
  pausedAt: number | null;
  /** Total paused time so far, the current pause included. */
  pausedMs: number;
}

export class PauseClock {
  private readonly now: () => number;
  private current: number | null = null;
  private spans: PauseSpan[] = [];

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get paused(): boolean {
    return this.current !== null;
  }

  /** Start a pause. False when already paused. */
  pause(): boolean {
    if (this.current !== null) return false;
    this.current = this.now();
    return true;
  }

  /** End the pause; returns its span, or null when not paused. */
  resume(): PauseSpan | null {
    if (this.current === null) return null;
    const span = { startedAt: this.current, endedAt: this.now() };
    this.spans.push(span);
    this.current = null;
    return span;
  }

  /** Paused milliseconds so far, the open pause included. */
  pausedMs(): number {
    const closed = this.spans.reduce((sum, s) => sum + (s.endedAt - s.startedAt), 0);
    return closed + (this.current === null ? 0 : this.now() - this.current);
  }

  snapshot(): PauseSnapshot {
    return { paused: this.paused, pausedAt: this.current, pausedMs: this.pausedMs() };
  }

  reset(): void {
    this.current = null;
    this.spans = [];
  }
}

/** The transcript line a resume leaves where the gap was, e.g.
 *  "Paused 17 min (2:02 PM–2:19 PM). Nothing was recorded.".
 *  Every LLM context reads `${label} ${text}`, so the gap is never stitched over. */
export function pauseMarkerText(span: PauseSpan, locale?: string): string {
  const mins = Math.round((span.endedAt - span.startedAt) / 60_000);
  const fmt = (ms: number) => new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (mins < 1) return `Paused under a minute (${fmt(span.startedAt)}). Nothing was recorded.`;
  return `Paused ${mins} min (${fmt(span.startedAt)}–${fmt(span.endedAt)}). Nothing was recorded.`;
}

export const PAUSE_MARKER_LABEL = '[Paused]';
