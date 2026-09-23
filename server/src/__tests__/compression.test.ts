import { describe, expect, it, vi, beforeEach } from 'vitest';

// Stand in for the provider chain: each test sets what "the model" replied.
const runLiveJson = vi.fn();
vi.mock('../intelligence/live-json.js', () => ({ runLiveJson }));

const { parseCompressionSummary, COMPRESSION_SCHEMA } = await import('../intelligence/compression.js');
const { IntelligenceEngine } = await import('../intelligence/index.js');
const { MODEL_CONFIG } = await import('../model-config.js');

const SUMMARY = 'They agreed to ship the pilot on the 30th; Dana owns the pricing page.';
const OBJECT = JSON.stringify({ summary: SUMMARY });

// The tail shapes gpt-6-luna wrote after a valid object in the 2026-09-22
// agenda replay (first-json.test.ts), applied to a summary. Without the
// object boundary, any of these would be pasted into every triage prompt.
const LEAKED_TAILS = [
  `${OBJECT}"} \n(Remember output contract use context_summary object no extra? response format requires summary; exactly)\n<br>\n{"summary":`,
  `${OBJECT}"} (Should just output)\n</|end|>{"summary":"They agreed`,
  `${OBJECT}${OBJECT}`,
  `${OBJECT}\n${JSON.stringify({ summary: 'A second, different paragraph.' })}`,
];

describe('parseCompressionSummary', () => {
  it.each(LEAKED_TAILS)('keeps only the first summary and drops the tail (%#)', (raw) => {
    expect(parseCompressionSummary(raw)).toBe(SUMMARY);
  });

  it('reads Haiku on the CLI, which fences its JSON', () => {
    expect(parseCompressionSummary('```json\n' + OBJECT + '\n```')).toBe(SUMMARY);
  });

  it('returns null for prose, an empty summary, or the wrong shape', () => {
    expect(parseCompressionSummary(SUMMARY)).toBeNull();
    expect(parseCompressionSummary('{"summary":"   "}')).toBeNull();
    expect(parseCompressionSummary('{"note":"thinking"}')).toBeNull();
    expect(parseCompressionSummary('')).toBeNull();
  });
});

function oldSegment(text: string, minutesAgo: number) {
  return {
    id: `seg-${Math.random().toString(36).slice(2, 8)}`,
    text,
    source: 'meeting' as const,
    label: '[Meeting]',
    timestamp: Date.now() - minutesAgo * 60_000,
    audioDurationSec: 4,
    transcriptionLatencyMs: 500,
    duration: 4,
    wordCount: text.split(/\s+/).length,
  };
}

function engineWithOldTranscript() {
  const engine = new IntelligenceEngine();
  engine.start();
  for (let i = 0; i < 12; i++) engine.addTranscript(oldSegment(`old line ${i}`, 8));
  engine.addTranscript(oldSegment('fresh line', 1));
  return engine;
}

describe('context compression', () => {
  beforeEach(() => runLiveJson.mockReset());

  it('runs on the luna lane with the summary schema', async () => {
    runLiveJson.mockResolvedValue({ text: OBJECT, provider: 'openai', model: 'gpt-6-luna', latencyMs: 900 });
    const engine = engineWithOldTranscript();
    await (engine as any).compressOldContext();
    engine.stop();

    expect(runLiveJson).toHaveBeenCalledTimes(1);
    const request = runLiveJson.mock.calls[0]![0];
    expect(request.openAiModel).toBe(MODEL_CONFIG.compression);
    expect(request.schema).toBe(COMPRESSION_SCHEMA);
    expect(request.prompt).toContain('old line 0');
    expect(request.prompt).not.toContain('fresh line');
  });

  it('carries a clean summary into the eval window when luna writes past its object', async () => {
    runLiveJson.mockResolvedValue({ text: LEAKED_TAILS[0], provider: 'openai', model: 'gpt-6-luna', latencyMs: 900 });
    const engine = engineWithOldTranscript();
    await (engine as any).compressOldContext();

    const window = engine.getTranscriptWindow();
    const summaries = (engine as any).contextSummaries;
    engine.stop();

    expect(summaries.map((s: { summary: string }) => s.summary)).toEqual([SUMMARY]);
    expect(window).toContain(`Earlier discussion (compressed):\n${SUMMARY}\n`);
    expect(window).not.toContain('Remember output contract');
    expect(engine.getFullTranscript()).toContain('fresh line');
    expect(engine.getFullTranscript()).not.toContain('old line 0');
  });

  it('keeps the old segments and reports an error when there is no summary', async () => {
    runLiveJson.mockResolvedValue({ text: 'Sure! Here is a summary of the meeting.', provider: 'claude-cli', model: 'haiku', latencyMs: 2000 });
    const engine = engineWithOldTranscript();
    const errors: unknown[] = [];
    engine.on('intelligence.error', (e) => errors.push(e));
    await (engine as any).compressOldContext();
    engine.stop();

    expect((engine as any).contextSummaries).toEqual([]);
    expect(engine.getFullTranscript()).toContain('old line 0');
    expect(errors).toEqual([{ error: 'Context compression failed: no summary in the model reply' }]);
  });

  it('drops a reply that lands after the meeting ended', async () => {
    let reply!: (v: unknown) => void;
    runLiveJson.mockReturnValue(new Promise((resolve) => { reply = resolve; }));
    const engine = engineWithOldTranscript();
    const pending = (engine as any).compressOldContext();
    engine.stop();
    engine.start(); // the next meeting
    reply({ text: OBJECT, provider: 'openai', model: 'gpt-6-luna', latencyMs: 900 });
    await pending;
    engine.stop();

    expect((engine as any).contextSummaries).toEqual([]);
  });
});
