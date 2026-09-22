import { describe, it, expect } from 'vitest';
import {
  END_OF_MEETING_SUMMARY_DESCRIPTION,
  hideSupersededRollingSummaries,
} from '../present/replay-actions.js';

const rolling = (id: string) => ({
  id,
  type: 'summary',
  state: 'completed',
  description: 'Auto-updating meeting summary (refreshes every 2 min)',
  params: JSON.stringify({ scope: 'full', _rolling: true }),
});
const final = (id: string, state = 'completed') => ({
  id,
  type: 'summary',
  state,
  description: END_OF_MEETING_SUMMARY_DESCRIPTION,
  params: JSON.stringify({ scope: 'full' }),
});
const research = (id: string) => ({
  id,
  type: 'research',
  state: 'completed',
  description: 'Look something up',
  params: JSON.stringify({ query: 'x' }),
});
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe('hideSupersededRollingSummaries', () => {
  it('hides the rolling summary once the end-of-meeting summary completed', () => {
    expect(ids(hideSupersededRollingSummaries([research('r'), rolling('live'), final('end'), research('r2')])))
      .toEqual(['r', 'end', 'r2']);
  });

  it('hides a rolling card a late refresh created after the final one', () => {
    // Sessions from July hold a second rolling row stamped after the final summary.
    expect(ids(hideSupersededRollingSummaries([rolling('live'), final('end'), rolling('late')])))
      .toEqual(['end']);
  });

  it('keeps the rolling summary when the final one failed or never ran', () => {
    expect(ids(hideSupersededRollingSummaries([rolling('live'), final('end', 'failed')])))
      .toEqual(['live', 'end']);
    expect(ids(hideSupersededRollingSummaries([rolling('live')]))).toEqual(['live']);
  });

  it('a summary asked for mid-meeting does not supersede the rolling one', () => {
    const asked = { ...final('asked'), description: 'Generate a concise recap of the playbook' };
    expect(ids(hideSupersededRollingSummaries([rolling('live'), asked]))).toEqual(['live', 'asked']);
  });

  it('survives missing or malformed params', () => {
    const odd = [{ ...rolling('a'), params: null }, { ...rolling('b'), params: '{not json' }, final('end')];
    expect(ids(hideSupersededRollingSummaries(odd))).toEqual(['a', 'b', 'end']);
  });
});
