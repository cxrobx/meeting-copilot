import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '../session/store.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

describe('SessionStore', () => {
  let store: SessionStore;
  const testSessionId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  beforeEach(() => {
    store = new SessionStore(testSessionId);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // Already closed
    }
    // Clean up test session directory
    const sessionDir = join(homedir(), '.meeting-copilot', 'sessions', testSessionId);
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  });

  it('creates a session', () => {
    const session = store.createSession('Test Meeting', ['projectA']);
    expect(session.id).toBe(testSessionId);
    expect(session.title).toBe('Test Meeting');
    expect(session.state).toBe('active');
  });

  it('retrieves the session', () => {
    store.createSession('Test');
    const session = store.getSession();
    expect(session).toBeDefined();
    expect(session!.title).toBe('Test');
  });

  it('updates session state', () => {
    store.createSession('Test');
    store.updateState('ended');

    const session = store.getSession();
    expect(session!.state).toBe('ended');
    expect(session!.endedAt).toBeDefined();
  });

  it('stores and retrieves transcript segments', () => {
    store.createSession('Test');
    store.addTranscript({
      id: 'seg-1',
      text: 'Hello world',
      source: 'mic',
      label: '[You]',
      timestamp: Date.now(),
      audioDurationSec: 4,
      transcriptionLatencyMs: 500,
      duration: 4,
      wordCount: 2,
    });

    const transcript = store.getTranscript();
    expect(transcript).toHaveLength(1);
    expect(transcript[0]!.text).toBe('Hello world');
    expect(transcript[0]!.source).toBe('mic');
  });

  it('stores and retrieves actions', () => {
    store.createSession('Test');
    store.addAction({
      id: 'action-1',
      type: 'research',
      title: 'Research topic',
      description: 'Look into this',
      triggerQuote: 'someone mentioned it',
      state: 'suggested',
      params: { query: 'test' },
      createdAt: Date.now(),
    });

    const actions = store.getActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe('research');
    expect(actions[0]!.title).toBe('Research topic');
  });

  it('updates action state and result', () => {
    store.createSession('Test');
    store.addAction({
      id: 'action-1',
      type: 'research',
      title: 'Test',
      description: '',
      triggerQuote: '',
      state: 'suggested',
      params: {},
      createdAt: Date.now(),
    });

    store.updateAction('action-1', {
      state: 'completed',
      result: { success: true, data: null, summary: 'done' },
      completedAt: Date.now(),
    });

    const actions = store.getActions();
    expect(actions[0]!.state).toBe('completed');
    expect(actions[0]!.result).toContain('done');
  });

  it('stores context summaries', () => {
    store.createSession('Test');
    store.addContextSummary({
      summary: 'Discussed project roadmap',
      windowStart: Date.now() - 60000,
      windowEnd: Date.now(),
    });

    const summaries = store.getSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.summary).toBe('Discussed project roadmap');
  });

  it('exports markdown', () => {
    store.createSession('Sprint Planning');
    store.addTranscript({
      id: 'seg-1',
      text: 'We need to ship by Friday',
      source: 'meeting',
      label: '[Meeting]',
      timestamp: Date.now(),
      audioDurationSec: 4,
      transcriptionLatencyMs: 500,
      duration: 4,
      wordCount: 6,
    });

    const md = store.exportMarkdown();
    expect(md).toContain('# Meeting: Sprint Planning');
    expect(md).toContain('We need to ship by Friday');
  });

  it('exports JSON', () => {
    store.createSession('Test');
    const json = store.exportJSON() as any;
    expect(json.session).toBeDefined();
    expect(json.transcript).toBeInstanceOf(Array);
    expect(json.actions).toBeInstanceOf(Array);
  });

  it('writes manifest on close', () => {
    store.createSession('Manifest Test');
    store.addTranscript({
      id: 'seg-1',
      text: 'test',
      source: 'mic',
      label: '[You]',
      timestamp: Date.now(),
      audioDurationSec: 4,
      transcriptionLatencyMs: 100,
      duration: 4,
      wordCount: 1,
    });

    store.close();

    const manifestPath = join(store.directory, 'manifest.json');
    const { existsSync, readFileSync } = require('node:fs');
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(manifest.sessionId).toBe(testSessionId);
    expect(manifest.transcriptSegments).toBe(1);
  });
});
