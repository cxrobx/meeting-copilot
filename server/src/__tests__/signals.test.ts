import { describe, it, expect } from 'vitest';
import { detectSignals, buildSignalRegexSources } from '../present/signals.js';

describe('signal detection', () => {
  it('tags real markers', () => {
    expect(detectSignals('We decided to go with option B')).toContain('decision');
    expect(detectSignals("I'll send the deck after this")).toContain('action');
    expect(detectSignals('That is a real blocker for launch')).toContain('risk');
    expect(detectSignals('Should we ship on Friday?')).toContain('question');
  });

  it('does NOT tag substring false positives (word boundaries)', () => {
    expect(detectSignals('It was a brisk walk')).not.toContain('risk');
    expect(detectSignals('The transaction settled')).not.toContain('action');
    expect(detectSignals('An asterisk in the doc')).not.toContain('risk');
    expect(detectSignals('The tissue samples arrived')).not.toContain('risk');
    expect(detectSignals('Handcannot is not a word but cannotish is')).not.toContain('risk');
  });

  it('question requires a question mark AND an interrogative', () => {
    expect(detectSignals('What time works?')).toContain('question');
    expect(detectSignals('Nice weather today?')).not.toContain('question');
    expect(detectSignals('what a great result')).not.toContain('question');
  });

  it('regex sources are valid and case-insensitive-ready', () => {
    const sources = buildSignalRegexSources();
    expect(() => new RegExp(sources.action, 'i')).not.toThrow();
    expect(new RegExp(sources.decision, 'i').test('WE DECIDED to move')).toBe(true);
  });

  it('multi-word and apostrophe markers still match', () => {
    expect(detectSignals('we should follow up on that')).toContain('action');
    expect(detectSignals("we can't merge until QA passes")).toContain('risk');
    expect(detectSignals('we are waiting on legal')).toContain('risk');
  });
});
