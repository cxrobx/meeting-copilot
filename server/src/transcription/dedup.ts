/**
 * Transcript overlap dedup (Phase 4).
 *
 * Problem: Swift emits 4s chunks every 3s with 1s overlap. Whisper
 * transcribes each chunk independently, so words at the boundary appear
 * in BOTH the prior chunk's suffix AND the next chunk's prefix. The UI,
 * SQLite store, shared transcript, and summaries all duplicate those
 * words. Example: "... that's down 22" then "That's down 22%".
 *
 * Solution: Ordered suffix/prefix token overlap. For each new segment,
 * find the longest sequence of normalized tokens at curr's START that
 * match prev's END (in order), and trim them from curr's original text
 * while preserving the original casing/punctuation. If the trim leaves
 * less than `minRemainingTokens`, drop the whole segment as a dupe.
 *
 * Why ordered suffix/prefix instead of Jaccard: Jaccard mis-fires on short
 * utterances that share vocabulary (e.g. "yes that's right" and "right
 * then let's move on" share "right" but aren't duplicates). Ordered
 * matching catches exactly the chunk-boundary case and nothing else.
 *
 * Applied at the server, BEFORE sessionStore.addTranscript / broadcast /
 * appendTranscript, so SQLite + UI + shared JSONL all see the deduped
 * text. Summaries and exports read from SQLite and are therefore clean
 * too (review feedback: UI-only dedup would leave stale text in exports).
 */

const FRESHNESS_MS = 15_000; // overlap only matters within a short window
const MIN_OVERLAP_TOKENS = 2;
const MIN_REMAINING_TOKENS = 2;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ') // strip punctuation but keep apostrophes
    .split(/\s+/)
    .filter(Boolean);
}

/** Longest suffix of `prev` that equals the prefix of `curr` (token-wise). */
function overlapLength(prev: string[], curr: string[]): number {
  const maxCheck = Math.min(prev.length, curr.length);
  // Try longest match first — almost always ≤ 1s of audio (a handful of tokens).
  for (let k = maxCheck; k >= 1; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i] !== curr[i]) {
        match = false;
        break;
      }
    }
    if (match) return k;
  }
  return 0;
}

/**
 * Drop the first `count` word runs from `text` and return the remainder
 * with any leading whitespace stripped. Preserves original casing /
 * punctuation on the retained portion.
 */
function dropLeadingTokens(text: string, count: number): string {
  if (count <= 0) return text;
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  let found = 0;
  let lastEnd = 0;
  while ((m = re.exec(text)) !== null) {
    found++;
    lastEnd = re.lastIndex;
    if (found >= count) break;
  }
  return text.slice(lastEnd).replace(/^[\s.,;:!?)\]]+/, '');
}

interface SourceState {
  tokens: string[];
  time: number;
}

export class TranscriptDedup {
  private lastBySource = new Map<string, SourceState>();

  /**
   * Return the (possibly trimmed) text to use for this segment, or an
   * empty string if the whole segment is duplicate and should be dropped.
   *
   * @param source  'mic' | 'meeting' — dedup is per-source (mic overlaps
   *                don't affect meeting overlaps).
   * @param text    Raw transcript from the provider.
   * @param time    Segment timestamp (epoch-ms).
   */
  dedup(source: string, text: string, time: number): string {
    const currTokens = tokenize(text);
    if (currTokens.length === 0) {
      return text; // nothing to compare, let upstream filter handle it
    }

    const prev = this.lastBySource.get(source);
    // Even if we drop the segment, record this observation so the next
    // chunk compares against the "real" audio, not a trimmed view.
    const recordObservation = () => {
      this.lastBySource.set(source, { tokens: currTokens, time });
    };

    if (!prev || time - prev.time > FRESHNESS_MS) {
      recordObservation();
      return text;
    }

    const overlap = overlapLength(prev.tokens, currTokens);
    if (overlap < MIN_OVERLAP_TOKENS) {
      recordObservation();
      return text;
    }

    const remaining = currTokens.length - overlap;
    if (remaining < MIN_REMAINING_TOKENS) {
      // Whole segment is duplicate of prev's tail — drop it.
      // Still record the observation so subsequent segments compute
      // overlap against the actual audio chain.
      recordObservation();
      return '';
    }

    const trimmed = dropLeadingTokens(text, overlap).trim();
    recordObservation();
    return trimmed;
  }

  /** Reset between sessions so one meeting's tail doesn't dedup the next. */
  reset(): void {
    this.lastBySource.clear();
  }
}
