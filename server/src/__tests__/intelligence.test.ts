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
    duration: 500,
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
