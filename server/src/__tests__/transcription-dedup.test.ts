import { describe, it, expect } from 'vitest';
import { TranscriptDedup } from '../transcription/dedup.js';

function at(offsetMs: number): number {
  return 1_000_000_000_000 + offsetMs;
}

describe('TranscriptDedup', () => {
  it('passes through the first segment unchanged', () => {
    const d = new TranscriptDedup();
    expect(d.dedup('meeting', 'Organics Search Over the last 12 months.', at(0))).toBe(
      'Organics Search Over the last 12 months.',
    );
  });

  it('drops a segment whose entire content is a duplicate of the prior tail', () => {
    const d = new TranscriptDedup();
    d.dedup('meeting', "Organics Search Over the last 12 months that's down 22", at(0));
    expect(d.dedup('meeting', "That's down 22%", at(3000))).toBe('');
  });

  it('trims overlapping prefix and keeps new content', () => {
    const d = new TranscriptDedup();
    d.dedup('meeting', "That's down 22%", at(0));
    expect(
      d.dedup('meeting', 'Down 22% in sessions, or in revenue from organic.', at(3000)),
    ).toBe('in sessions, or in revenue from organic.');
  });

  it('does NOT dedup when isContinuation=false (VAD pause-triggered utterance)', () => {
    const d = new TranscriptDedup();
    // Two utterances that happen to share trailing/leading words, separated
    // by a pause. VAD reports isContinuation=false on the second.
    d.dedup('meeting', "Yeah that's down 22", at(0), false);
    expect(d.dedup('meeting', "down 22 percent is a lot", at(3000), false)).toBe(
      "down 22 percent is a lot",
    );
  });

  it('dedups when isContinuation=true even if false was used for prior (mixed sequence)', () => {
    const d = new TranscriptDedup();
    d.dedup('meeting', "That's down 22%", at(0), false);
    // Next chunk IS a max-utterance carry — dedup should apply.
    expect(
      d.dedup('meeting', 'Down 22% in sessions', at(3000), true),
    ).toBe('in sessions');
  });

  it('does not dedup distinct short utterances that share vocabulary', () => {
    const d = new TranscriptDedup();
    d.dedup('meeting', "yes that's right", at(0));
    // "right" is shared but not ordered suffix/prefix overlap of ≥2 tokens.
    expect(d.dedup('meeting', "then let's move on", at(3000))).toBe(
      "then let's move on",
    );
  });

  it('treats mic and meeting as separate streams', () => {
    const d = new TranscriptDedup();
    d.dedup('meeting', 'Down 22% in sessions', at(0));
    // Same tokens on mic stream should NOT be deduped.
    expect(d.dedup('mic', 'Down 22% in sessions', at(1000))).toBe('Down 22% in sessions');
  });

  it('respects the freshness window — old prev does not dedup new current', () => {
    const d = new TranscriptDedup();
    d.dedup('meeting', 'Down 22% in sessions', at(0));
    // 20s later — prev is stale.
    expect(d.dedup('meeting', 'Down 22% in sessions', at(20_000))).toBe(
      'Down 22% in sessions',
    );
  });

  it('handles case-insensitive matching', () => {
    const d = new TranscriptDedup();
    d.dedup('meeting', "Organics Search Over the last 12 months that's down 22", at(0));
    expect(d.dedup('meeting', "THAT'S DOWN 22%", at(3000))).toBe('');
  });

  it('resets state between sessions', () => {
    const d = new TranscriptDedup();
    d.dedup('meeting', 'Down 22% in sessions', at(0));
    d.reset();
    expect(d.dedup('meeting', 'Down 22% in sessions', at(1000))).toBe(
      'Down 22% in sessions',
    );
  });

  it('does not dedup when overlap is only 1 token', () => {
    const d = new TranscriptDedup();
    d.dedup('meeting', 'We should ship this soon', at(0));
    // "soon" matches but overlap needs ≥ 2 tokens.
    expect(d.dedup('meeting', 'soon enough we will know more', at(3000))).toBe(
      'soon enough we will know more',
    );
  });
});
