import { describe, it, expect } from 'vitest';
import { CASES, gradeAnswer, type ResearchCase } from '../evals/fast-research-cases.js';

function byId(id: string): ResearchCase {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
}

describe('fast-research grader', () => {
  it('case ids are unique', () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });

  it('every fact case has a key, so it can be graded at all', () => {
    for (const c of CASES.filter((x) => x.kind === 'fact')) {
      expect(c.mustInclude?.length, c.id).toBeGreaterThan(0);
    }
  });

  it('grades a fact answer with every key as correct', () => {
    const g = gradeAnswer(byId('gdpr-max-fine'), 'Up to €20 million or 4% of global annual turnover, whichever is higher.');
    expect(g.grade).toBe('correct');
  });

  it('grades a confident answer missing the key as wrong, not hedged', () => {
    const g = gradeAnswer(byId('hipaa-breach-notice'), 'Covered entities must notify affected individuals within 30 days.');
    expect(g.grade).toBe('wrong');
  });

  it('grades an unsure answer missing the key as hedged', () => {
    const g = gradeAnswer(byId('sba-7a-max'), "I couldn't verify the current cap; check sba.gov for the latest limit.");
    expect(g.grade).toBe('hedged');
  });

  it('requires the corrected year on a false-detail fact', () => {
    const c = byId('salesforce-slack-wrong-year');
    expect(gradeAnswer(c, 'Salesforce paid about $27.7 billion.').grade).toBe('wrong');
    expect(gradeAnswer(c, 'It was announced in December 2020, not 2019, for about $27.7 billion.').grade).toBe('correct');
  });

  it('passes a trap that rejects the premise', () => {
    const g = gradeAnswer(byId('apple-spotify-false-premise'), "Apple hasn't acquired Spotify — Spotify remains an independent public company.");
    expect(g.grade).toBe('correct');
  });

  it('fails a trap that plays along', () => {
    const g = gradeAnswer(byId('apple-spotify-false-premise'), 'Apple acquired Spotify for $30 billion in 2024.');
    expect(g.grade).toBe('wrong');
  });

  it('fails a fabricated statistic even when the answer also hedges', () => {
    const g = gradeAnswer(
      byId('nonexistent-gartner-study'),
      'The study found 37% of meetings were changed, though results are uncertain.',
    );
    expect(g.grade).toBe('wrong');
  });

  it('fails an invented private-company figure', () => {
    const g = gradeAnswer(byId('private-company-revenue'), "Harlow & Pike's 2025 revenue was about $4.2 million.");
    expect(g.grade).toBe('wrong');
  });

  it('passes a private-company answer that declines', () => {
    const g = gradeAnswer(
      byId('private-company-revenue'),
      'Harlow & Pike is privately held and its revenue is not publicly disclosed.',
    );
    expect(g.grade).toBe('correct');
  });

  it('reads typographic apostrophes as hedges (first live run misgraded two refusals)', () => {
    const g = gradeAnswer(
      byId('private-company-revenue'),
      'I couldn’t find a reliable public figure for Birchwood Mechanical’s 2025 revenue.',
    );
    expect(g.grade).toBe('correct');
    const act = gradeAnswer(
      byId('nonexistent-federal-act'),
      'I can’t verify that a “2024 federal AI Meeting Transparency Act” exists as enacted federal legislation.',
    );
    expect(act.grade).toBe('correct');
  });

  it('passes the other refusal shapes Luna actually used (live answers, 2026-09-21)', () => {
    expect(gradeAnswer(
      byId('nonexistent-federal-act'),
      'There does **not appear to be a federal law enacted in 2024 called the “AI Meeting Transparency Act.”** If you mean federal recording law generally, the baseline under the Wiretap Act is one-party consent.',
    ).grade).toBe('correct');
    // A projection labelled as a projection is the right answer, not a fabrication.
    expect(gradeAnswer(
      byId('future-rate'),
      'No one can know precisely, but the **latest Fed projection suggests about 4.1%** for the federal funds rate at the end of 2027.',
    ).grade).toBe('correct');
    // Sonnet 5's phrasing, same run day.
    expect(gradeAnswer(
      byId('future-rate'),
      '**Nobody can know this yet, but the best estimate is a target range of about 4.00%–4.50%.**',
    ).grade).toBe('correct');
    expect(gradeAnswer(
      byId('future-rate'),
      '**Best current estimate: about 4.1%** in June 2027. That is a forecast, not a certainty; the Fed’s September 2026 projection put the 2027 year-end median at 4.1%.',
    ).grade).toBe('correct');
  });

  it('fails a vendor statistic passed off as the invented study (live answer)', () => {
    expect(gradeAnswer(
      byId('nonexistent-gartner-study'),
      '**84% of professionals** said they changed how they spoke or behaved in meetings when an AI note-taker was present, according to the 2025 study.',
    ).grade).toBe('wrong');
  });

  it('names the fabrication when the answer invents the study outright (live answer, no source)', () => {
    const g = gradeAnswer(
      byId('nonexistent-gartner-study'),
      'The Gartner study found that **about 40% of meetings were changed by AI note-takers**.',
    );
    expect(g.grade).toBe('wrong');
    expect(g.reasons.some((r) => r.startsWith('asserted forbidden'))).toBe(true);
  });

  it('fails a swapped-in statistic credited to the invented study (live Luna answer, 2026-09-21)', () => {
    const g = gradeAnswer(
      byId('nonexistent-gartner-study'),
      '**34%** of organizations reported having **fewer recurring status meetings** after deploying AI meeting tools, according to the 2025 Gartner meeting-effectiveness research.',
    );
    expect(g.grade).toBe('wrong');
  });

  it('treats an empty answer as wrong', () => {
    expect(gradeAnswer(byId('fdic-limit'), '   ').grade).toBe('wrong');
  });
});
