/**
 * Transcript self-healing (sentence stitching).
 *
 * Problem: whisper transcribes short fixed chunks independently, so the live
 * transcript is a stream of cut-off fragments — "The", "And so.", "Maybe it's
 * like an email tracking situation where…". Each is its own line in the UI and
 * its own row in SQLite, which reads choppy and pollutes summaries/triage.
 *
 * Solution: a deterministic, real-time stitcher (sibling to dedup.ts) applied
 * right AFTER dedup and BEFORE persist/broadcast. It maintains one OPEN segment
 * per source with a stable id and appends incoming fragments to it until the
 * sentence closes — at which point ONE cohesive segment is persisted + fed to
 * intelligence + appended to the shared JSONL.
 *
 * Emit model: the stitcher emits a single `segment` event:
 *   { segment, final: false }  → open segment grew/started (broadcast only)
 *   { segment, final: true }   → segment closed (broadcast + persist downstream)
 * The open segment keeps a STABLE id across grows, so the UI replaces the line
 * in place (replace:true) instead of inserting a new one each time.
 *
 * Close (flush) triggers: terminal punctuation reached, speaker/source switch,
 * a max-hold silence timeout, or flushAll() at session.stop.
 */

import { EventEmitter } from 'node:events';
import type { TranscriptSegment } from './types.js';

const MAX_HOLD_MS = 6_000; // close an open segment after this much source silence
const MAX_GAP_MS = 6_000; // a fragment arriving after this long starts fresh

// Leading function words whisper capitalizes at chunk boundaries that should be
// lowercased when they continue a sentence. Deliberately excludes "I" and any
// word that could be a proper noun / month, so we never mangle names.
const SEAM_LOWERCASE = new Set([
  'the', 'a', 'an', 'and', 'but', 'or', 'nor', 'so', 'yet', 'then', 'than',
  'that', 'this', 'these', 'those', 'it', 'its', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'to', 'of', 'in', 'on', 'for', 'with', 'as', 'at',
  'by', 'from', 'about', 'into', 'over', 'after', 'before', 'because', 'since',
  'while', 'when', 'where', 'which', 'who', 'whom', 'whose', 'what', 'how',
  'why', 'if', 'unless', 'although', 'though', 'maybe', 'like', 'just', 'also',
  'too', 'very', 'really', 'actually', 'basically', 'we', 'you', 'they', 'he',
  'she', 'our', 'your', 'their', 'his', 'her', 'my', 'not', 'no',
]);

/** A sentence is "closed" when it ends in terminal punctuation (+ optional quote). */
export function endsWithTerminal(text: string): boolean {
  return /[.?!…]["'”’)\]]?\s*$/.test(text.trim());
}

/** Lowercase a continuation fragment's first word when it's a safe function word. */
function lowercaseSeam(fragment: string): string {
  const m = fragment.match(/^[A-Za-z']+/);
  if (!m) return fragment;
  const first = m[0];
  if (/^[A-Z]/.test(first) && SEAM_LOWERCASE.has(first.toLowerCase())) {
    return first.charAt(0).toLowerCase() + fragment.slice(1);
  }
  return fragment;
}

/** Join an open segment's text with a continuation fragment, normalizing the seam. */
function joinSeam(open: string, fragment: string): string {
  const left = open.replace(/\s+$/g, '');
  const right = lowercaseSeam(fragment.replace(/^\s+/g, ''));
  if (!left) return right;
  // No space before leading closing punctuation ("word" + ", x" → "word, x").
  if (/^[,.;:!?)\]]/.test(right)) return left + right;
  return left + ' ' + right;
}

interface OpenSegment {
  id: string;
  text: string;
  source: 'mic' | 'meeting';
  label: string;
  firstTimestamp: number;
  audioDurationSec: number;
  transcriptionLatencyMs: number;
  captureStartedAt?: string;
  captureEndedAt?: string;
  sequence?: number;
  lastActivity: number; // real epoch-ms, for the silence timeout / gap check
  timer: ReturnType<typeof setTimeout> | null;
}

export class TranscriptStitcher extends EventEmitter {
  private open = new Map<string, OpenSegment>();
  private readonly maxHoldMs: number;
  private readonly maxGapMs: number;

  constructor(opts: { maxHoldMs?: number; maxGapMs?: number } = {}) {
    super();
    this.maxHoldMs = opts.maxHoldMs ?? MAX_HOLD_MS;
    this.maxGapMs = opts.maxGapMs ?? MAX_GAP_MS;
  }

  /**
   * Feed one deduped, non-empty fragment. Emits `segment` events synchronously
   * for any growth/close it produces.
   */
  push(fragment: TranscriptSegment): void {
    const text = (fragment.text ?? '').trim();
    if (!text) return;
    const source = fragment.source;

    // Source switch: a new speaker closes the other source's dangling sentence.
    for (const otherSource of Array.from(this.open.keys())) {
      if (otherSource !== source) this.closeOpen(otherSource);
    }

    const nowReal = Date.now();
    const existing = this.open.get(source);

    if (existing) {
      const gap = nowReal - existing.lastActivity;
      const continues = !endsWithTerminal(existing.text) && gap <= this.maxGapMs;
      if (continues) {
        this.appendFragment(existing, fragment, text, nowReal);
        if (endsWithTerminal(existing.text)) {
          this.closeOpen(source); // terminal punctuation → finalize
        } else {
          this.emitOpen(existing);
          this.armTimer(source);
        }
        return;
      }
      // Can't continue (already terminal, or too long a gap) → close it first.
      this.closeOpen(source);
    }

    // Start a fresh open segment from this fragment.
    const fresh = this.startOpen(fragment, text, nowReal);
    if (endsWithTerminal(fresh.text)) {
      this.closeOpen(source); // single fragment is already a complete sentence
    } else {
      this.emitOpen(fresh);
      this.armTimer(source);
    }
  }

  /** Close every open segment (e.g. on session.stop). */
  flushAll(): void {
    for (const source of Array.from(this.open.keys())) {
      this.closeOpen(source);
    }
  }

  /** Drop all state + timers WITHOUT emitting (between sessions). */
  reset(): void {
    for (const o of this.open.values()) {
      if (o.timer) clearTimeout(o.timer);
    }
    this.open.clear();
  }

  private appendFragment(
    o: OpenSegment,
    frag: TranscriptSegment,
    text: string,
    nowReal: number,
  ): void {
    o.text = joinSeam(o.text, text);
    o.audioDurationSec += frag.audioDurationSec || 0;
    o.transcriptionLatencyMs = frag.transcriptionLatencyMs;
    o.captureEndedAt = frag.captureEndedAt ?? o.captureEndedAt;
    o.lastActivity = nowReal;
  }

  private startOpen(frag: TranscriptSegment, text: string, nowReal: number): OpenSegment {
    const o: OpenSegment = {
      id: frag.id, // reuse the fragment's stable id as the open-segment id
      text,
      source: frag.source,
      label: frag.label,
      firstTimestamp: frag.timestamp,
      audioDurationSec: frag.audioDurationSec || 0,
      transcriptionLatencyMs: frag.transcriptionLatencyMs,
      captureStartedAt: frag.captureStartedAt,
      captureEndedAt: frag.captureEndedAt,
      sequence: frag.sequence,
      lastActivity: nowReal,
      timer: null,
    };
    this.open.set(frag.source, o);
    return o;
  }

  private toSegment(o: OpenSegment): TranscriptSegment {
    const wordCount = o.text.split(/\s+/).filter(Boolean).length;
    return {
      id: o.id,
      text: o.text,
      source: o.source,
      label: o.label,
      timestamp: o.firstTimestamp,
      audioDurationSec: o.audioDurationSec,
      transcriptionLatencyMs: o.transcriptionLatencyMs,
      captureStartedAt: o.captureStartedAt,
      captureEndedAt: o.captureEndedAt,
      sequence: o.sequence,
      duration: o.audioDurationSec,
      wordCount,
    };
  }

  private emitOpen(o: OpenSegment): void {
    this.emit('segment', { segment: this.toSegment(o), final: false });
  }

  private closeOpen(source: string): void {
    const o = this.open.get(source);
    if (!o) return;
    if (o.timer) {
      clearTimeout(o.timer);
      o.timer = null;
    }
    this.open.delete(source);
    this.emit('segment', { segment: this.toSegment(o), final: true });
  }

  private armTimer(source: string): void {
    const o = this.open.get(source);
    if (!o) return;
    if (o.timer) clearTimeout(o.timer);
    o.timer = setTimeout(() => {
      o.timer = null;
      this.closeOpen(source); // max-hold silence → finalize
    }, this.maxHoldMs);
    if (typeof o.timer.unref === 'function') o.timer.unref();
  }
}
