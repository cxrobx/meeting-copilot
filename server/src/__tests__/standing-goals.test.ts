import { describe, expect, it } from 'vitest';
import { standingGoals, type ReviewRecord } from '../session/reviewStore.js';

function review(scores: Partial<ReviewRecord['scores']>, talkRatio?: number, goals: string[] = []): ReviewRecord {
  return {
    date: '2026-09-21T21:33:38.866Z',
    title: 'A meeting',
    sessionId: Math.random().toString(36).slice(2),
    scores: { clarity: 3, decisiveness: 3, concision: 3, ...scores },
    goals,
    talkRatio,
  };
}

describe('standing goals from recent self-reviews', () => {
  it('turns what the last reviews keep repeating into goals, with the evidence', () => {
    // The shape of the six real reviews on 2026-09-22.
    const reviews = [
      review({ concision: 2 }, 0.44, ["Replace 'I'm open to it' with an explicit recommendation"]),
      review({ concision: 2 }, 0.88, ['Close with explicit next steps — proposed scope, ownership']),
      review({ decisiveness: 4, concision: 2 }, 0.38, ['End every piece of advice with one concrete next action']),
      review({ decisiveness: 4, concision: 2 }, 0.38, ['Answer the literal question in your first sentence']),
      review({ concision: 2 }, 0.57, ['Close with a written list of owners']),
      review({ concision: 3 }, 0.64, ['Before the call ends, suggest one specific next step']),
    ];
    const standing = standingGoals(reviews);
    expect(standing?.goals).toEqual([
      'Answer the question in your first sentence, then expand.',
      'Keep your share of the talking under half: ask, then listen.',
      'Before it ends, name one next step with an owner and a date.',
    ]);
    expect(standing?.evidence[0]).toBe('concision 2/5 or lower in 4 of 5');
    expect(standing?.reviewed).toBe(5);
  });

  it('says nothing from a single review — that is a meeting, not a pattern', () => {
    expect(standingGoals([review({ concision: 1 }, 0.9, ['next step'])])).toBeNull();
  });

  it('leaves out a dimension that is only weak in a minority of reviews', () => {
    const standing = standingGoals([
      review({ clarity: 2 }),
      review({ clarity: 4 }),
      review({ clarity: 4 }),
    ]);
    expect(standing).toBeNull();
  });

  it('ignores reviews with no talk ratio rather than counting them as quiet', () => {
    const standing = standingGoals([review({}, 0.8), review({}), review({}, 0.7)]);
    expect(standing?.goals).toEqual(['Keep your share of the talking under half: ask, then listen.']);
    expect(standing?.evidence[0]).toBe('talk share over 55% in 2 of 2');
  });

  it('only looks at the most recent window', () => {
    const old = Array.from({ length: 5 }, () => review({ decisiveness: 1 }));
    const recent = Array.from({ length: 5 }, () => review({}));
    expect(standingGoals([...old, ...recent])).toBeNull();
  });
});
