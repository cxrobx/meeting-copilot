import { describe, expect, it } from 'vitest';
import { MODEL_CONFIG } from '../model-config.js';
import { WhisperProvider } from '../transcription/whisper.js';
import { DeepgramProvider } from '../transcription/deepgram.js';

describe('central model and provider configuration', () => {
  it('uses current live and review model defaults', () => {
    expect(MODEL_CONFIG.triage).toBe(process.env.COPILOT_TRIAGE_MODEL || 'gpt-6-luna');
    expect(MODEL_CONFIG.agenda).toBe(process.env.COPILOT_AGENDA_MODEL || 'gpt-6-luna');
    expect(MODEL_CONFIG.agendaReconcile).toBe(
      process.env.COPILOT_AGENDA_RECONCILE_MODEL || 'gpt-6-luna',
    );
    // Luna since 2026-09-19: same 100/100 on the frozen coach cases across 3
    // runs each, 10x cheaper, and a tail that actually lands inside the
    // advice deadline. See model-config.ts for the numbers.
    expect(MODEL_CONFIG.coach).toBe(process.env.COPILOT_COACH_MODEL || 'gpt-6-luna');
    expect(MODEL_CONFIG.suggestion).toBe(
      process.env.COPILOT_SUGGEST_MODEL
        || process.env.COPILOT_SUGGESTION_MODEL
        || 'claude-sonnet-5',
    );
    expect(MODEL_CONFIG.review).toBe(process.env.COPILOT_REVIEW_MODEL || 'claude-opus-5');
  });

  it('reports capabilities instead of silently accepting unsupported context', () => {
    const parakeet = new WhisperProvider('http://127.0.0.1:8077', {
      mode: 'parakeet',
      supportsPrompt: false,
    }).getInfo();
    expect(parakeet).toMatchObject({
      mode: 'parakeet',
      supportsPrompt: false,
      supportsKeyterms: false,
      streaming: false,
      audioStorage: 'memory-only',
    });

    expect(new DeepgramProvider('test').getInfo()).toMatchObject({
      mode: 'deepgram',
      model: 'nova-3',
      supportsKeyterms: true,
      audioStorage: 'remote-ephemeral',
    });
  });
});
