import { describe, it, expect, beforeEach } from 'vitest';
import { IntelligenceEngine } from '../intelligence/index.js';
import type { TranscriptSegment } from '../transcription/types.js';

function makeSegment(text: string, timestamp?: number): TranscriptSegment {
  return {
    id: `seg-${Math.random().toString(36).slice(2, 8)}`,
    text,
    source: 'meeting',
    label: '[Meeting]',
    timestamp: timestamp ?? Date.now(),
    audioDurationSec: 4,
    transcriptionLatencyMs: 500,
    duration: 4,
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}

describe('IntelligenceEngine', () => {
  let engine: IntelligenceEngine;

  beforeEach(() => {
    engine = new IntelligenceEngine();
  });

  it('starts in stopped state', () => {
    expect(engine.isRunning).toBe(false);
  });

  it('starts and stops', () => {
    engine.start();
    expect(engine.isRunning).toBe(true);
    engine.stop();
    expect(engine.isRunning).toBe(false);
  });

  it('accepts transcript segments', () => {
    engine.addTranscript(makeSegment('hello world'));
    expect(engine.getFullTranscript()).toContain('hello world');
  });

  it('returns transcript window with recent segments only', () => {
    // Add an old segment (6 minutes ago — outside 5min window)
    const oldTs = Date.now() - 6 * 60 * 1000;
    engine.addTranscript(makeSegment('old message', oldTs));
    engine.addTranscript(makeSegment('recent message'));

    const window = engine.getTranscriptWindow();
    expect(window).toContain('recent message');
    expect(window).not.toContain('old message');
  });

  it('re-injects the last 2 compressed context summaries into the eval window', () => {
    (engine as any).contextSummaries.push(
      { summary: 'Discussed the Q3 launch plan', windowStart: 0, windowEnd: 1, createdAt: Date.now() },
      { summary: 'Agreed to hire two engineers', windowStart: 1, windowEnd: 2, createdAt: Date.now() },
      { summary: 'Budget review parked for Friday', windowStart: 2, windowEnd: 3, createdAt: Date.now() },
    );
    engine.addTranscript(makeSegment('recent message'));

    const window = engine.getTranscriptWindow();
    expect(window).toContain('Earlier discussion (compressed)');
    // Only the LAST 2 summaries ride along — older history stays in SQLite.
    expect(window).not.toContain('Q3 launch plan');
    expect(window).toContain('hire two engineers');
    expect(window).toContain('Budget review parked');
    expect(window).toContain('recent message');
  });

  it('returns full transcript including old segments', () => {
    const oldTs = Date.now() - 6 * 60 * 1000;
    engine.addTranscript(makeSegment('old message', oldTs));
    engine.addTranscript(makeSegment('recent message'));

    const full = engine.getFullTranscript();
    expect(full).toContain('old message');
    expect(full).toContain('recent message');
  });

  it('initializes metrics at zero', () => {
    expect(engine.evalsRun).toBe(0);
    expect(engine.haikuActionableCount).toBe(0);
    expect(engine.sonnetCallCount).toBe(0);
    expect(engine.haikuHitRate).toBe(0);
    expect(engine.sonnetCallRate).toBe(0);
    expect(engine.avgSuggestionLatencyMs).toBe(0);
  });

  it('filters empty text segments from transcript', () => {
    engine.addTranscript(makeSegment(''));
    engine.addTranscript(makeSegment('visible'));

    const full = engine.getFullTranscript();
    expect(full).toBe('[Meeting] visible');
  });

  it('sets and retrieves project context', () => {
    engine.setProjectContext([
      { name: 'test-project', path: '/tmp/test', brief: '# Test', fileTree: '' },
    ]);
    expect(engine.getProjectContext()).toHaveLength(1);
    expect(engine.projectNames).toEqual(['test-project']);
  });

  it('clears project context on stop', () => {
    engine.setProjectContext([
      { name: 'test-project', path: '/tmp/test', brief: '# Test', fileTree: '' },
    ]);
    engine.start();
    engine.stop();
    expect(engine.getProjectContext()).toHaveLength(0);
  });
});
