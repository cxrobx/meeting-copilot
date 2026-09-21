import { describe, it, expect } from 'vitest';
import { routeSuggestedType } from '../intelligence/suggested-type.js';

describe('routeSuggestedType', () => {
  it('runs suggested research on Fast by default', () => {
    expect(routeSuggestedType('research', {})).toBe('fast-research');
  });

  it('puts it back on Sonnet with COPILOT_SUGGESTED_RESEARCH=deep', () => {
    expect(routeSuggestedType('research', { COPILOT_SUGGESTED_RESEARCH: 'deep' })).toBe('research');
  });

  it('leaves every other card type alone', () => {
    for (const t of ['summary', 'analysis', 'mockup', 'codegen', 'fast-research'] as const) {
      expect(routeSuggestedType(t, {})).toBe(t);
    }
  });
});
