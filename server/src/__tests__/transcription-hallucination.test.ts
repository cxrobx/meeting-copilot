import { describe, it, expect } from 'vitest';
import { isLikelyHallucination } from '../transcription/index.js';

describe('isLikelyHallucination', () => {
  it('flags known whisper silence hallucinations', () => {
    for (const phrase of [
      'you',
      'You',
      'you.',
      'You.',
      ' You ',
      'thank you',
      'Thank you.',
      'thanks',
      'Thanks for watching!',
      'thanks for watching',
      'bye',
      'Bye.',
      '...',
      '.',
      'okay',
      'Uh',
      'Yeah',
    ]) {
      expect(isLikelyHallucination(phrase), `should flag: ${phrase}`).toBe(true);
    }
  });

  it('flags bracketed / parenthesized sound descriptions', () => {
    for (const phrase of [
      '[Silence]',
      '[ Silence ]',
      '[silence]',
      '[Music]',
      '[typing sounds]',
      '[ typing sounds ]',
      '(bell dings)',
      '(keyboard clacking)',
    ]) {
      expect(isLikelyHallucination(phrase), `should flag: ${phrase}`).toBe(true);
    }
  });

  it('does not flag real speech even when it contains hallucination words', () => {
    for (const phrase of [
      'Walk us through',
      'Walk us through month one.',
      'What does the technical audit cover?',
      'Thank you for the detailed walkthrough of the pipeline.',
      'Can you show me the dashboard?',
      'Yeah, I think we should move to option B.',
      'Okay, let me share my screen.',
    ]) {
      expect(isLikelyHallucination(phrase), `should NOT flag: ${phrase}`).toBe(
        false,
      );
    }
  });

  it('flags empty / whitespace', () => {
    expect(isLikelyHallucination('')).toBe(true);
    expect(isLikelyHallucination('   ')).toBe(true);
  });
});
