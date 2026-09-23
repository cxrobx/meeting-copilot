import { describe, it, expect } from 'vitest';
import { checkAttributions, citationFooter, extractUrlSources, stripSourceList } from '../workers/citations.js';

const src = (url: string) => ({ url, title: '' });

describe('checkAttributions — the fabrications Luna produced on 2026-09-21', () => {
  it('flags a named study credited with no citations at all', () => {
    const got = checkAttributions(
      'The Gartner study found that **about 40% of meetings were changed by AI note-takers**.',
      [],
    );
    expect(got.map((u) => u.source)).toEqual(['Gartner']);
  });

  it('flags a named study whose only citation is someone else (vendor blog)', () => {
    const got = checkAttributions(
      'The 2025 Gartner study found that **more than 50% of business meetings** were expected to involve AI transcription or note-taking tools by 2026.',
      [src('https://proactor.ai/blog/proactor-vs-read/?utm_source=openai')],
    );
    expect(got.map((u) => u.source)).toEqual(['Gartner']);
  });

  it('flags "according to" attribution', () => {
    const got = checkAttributions(
      '**34%** of organizations reported having fewer recurring status meetings after deploying AI meeting tools, according to the 2025 Gartner meeting-effectiveness research.',
      [src('https://stealthagents.com/research/ai-meeting-assistant-adoption-statistics-2026')],
    );
    expect(got.map((u) => u.source)).toEqual(['Gartner']);
  });
});

describe('checkAttributions — what it must leave alone', () => {
  it('passes a named finding cited to the source itself', () => {
    expect(checkAttributions(
      'Gartner found that 40% of enterprise apps will embed AI agents by 2026.',
      [src('https://www.gartner.com/en/newsroom/press-releases/2025-08-26-gartner-predicts')],
    )).toEqual([]);
  });

  it('passes a refusal that names the missing source (curly apostrophe, as Luna writes it)', () => {
    expect(checkAttributions(
      'I couldn’t find a 2025 Gartner study on how often AI note-takers change meetings. The closest data I found is a Fellow survey.',
      [src('https://fellow.ai/blog/ai-notetaker-statistics/')],
    )).toEqual([]);
  });

  it('passes a bare mention that credits nothing', () => {
    expect(checkAttributions('Gartner is a research and advisory firm.', [])).toEqual([]);
  });

  it('passes a cited, unnamed study (the known gap: a vendor stat cited as itself)', () => {
    // Live answer: "…according to the 2025 study" citing fellow.ai. Not a named
    // source, and it IS cited, so this check cannot tell it apart from an
    // honest citation. The eval's Gartner trap still catches it.
    expect(checkAttributions(
      '84% of professionals said they changed how they spoke when an AI note-taker was present, according to the 2025 study.',
      [src('https://fellow.ai/blog/ai-notetaker-statistics/')],
    )).toEqual([]);
  });
});

describe('checkAttributions — unnamed studies', () => {
  it('flags an unnamed study credited with a finding when nothing is cited', () => {
    const got = checkAttributions('A 2024 survey found that 62% of managers prefer async updates.', []);
    expect(got.map((u) => u.source)).toEqual(['a study']);
  });

  it('reports each source once, however many sentences repeat it', () => {
    const got = checkAttributions(
      'Gartner found 40% adoption. Gartner also reported 25% savings. According to Forrester, 30% more.',
      [],
    );
    expect(got.map((u) => u.source)).toEqual(['Gartner', 'Forrester']);
  });
});

describe('extractUrlSources', () => {
  it('prefers markdown titles, dedupes bare repeats, strips the openai utm tag', () => {
    const got = extractUrlSources(
      'Per the FTC ([ftc.gov](https://www.ftc.gov/rule?utm_source=openai)), see also https://www.ftc.gov/rule and https://oag.ca.gov/privacy/ccpa.',
    );
    expect(got).toEqual([
      { url: 'https://www.ftc.gov/rule', title: 'ftc.gov' },
      { url: 'https://oag.ca.gov/privacy/ccpa', title: 'oag.ca.gov' },
    ]);
  });

  it('returns nothing for an answer with no links', () => {
    expect(extractUrlSources('The FDIC limit is $250,000 per depositor.')).toEqual([]);
  });
});

describe('citationFooter', () => {
  it('leads with the warning, then the numbered sources', () => {
    const footer = citationFooter(
      [src('https://proactor.ai/blog/x')],
      [{ source: 'Gartner', sentence: 'The 2025 Gartner study found…' }],
    );
    expect(footer).toMatch(/Source not verified:\*\* this answer credits Gartner/);
    expect(footer.indexOf('Source not verified')).toBeLessThan(footer.indexOf('**Sources**'));
    expect(footer).toContain('[1] [https://proactor.ai/blog/x](https://proactor.ai/blog/x)');
  });

  it('says so plainly when nothing was cited', () => {
    expect(citationFooter([], [])).toContain('No sources cited');
  });
});

describe('stripSourceList', () => {
  // The two endings deep research wrote on the 2026-09-22 real-question run.
  it('drops a bold "Sources:" list the model wrote at the end', () => {
    const answer = 'Kling is strongest ([fal](https://fal.ai)).\n\n**Sources:**\n- [BuildMVPFast](https://a.example)\n- [Apiframe](https://b.example)\n';
    expect(stripSourceList(answer)).toBe('Kling is strongest ([fal](https://fal.ai)).');
  });

  it('drops a plain "Sources:" list', () => {
    const answer = 'Answer body.\n\nSources:\n- [Kapwing](https://k.example)\n- [Wikipedia](https://w.example)';
    expect(stripSourceList(answer)).toBe('Answer body.');
  });

  it('drops a heading "## Sources" with numbered entries', () => {
    const answer = 'Body.\n\n## Sources\n1. [One](https://1.example)\n2. [Two](https://2.example)\n';
    expect(stripSourceList(answer)).toBe('Body.');
  });

  it('keeps an answer whose sources section is not at the end', () => {
    const answer = 'Intro.\n\n**Sources:**\n- [One](https://1.example)\n\nMore analysis after the list.';
    expect(stripSourceList(answer)).toBe(answer);
  });

  it('keeps an answer with no sources list', () => {
    expect(stripSourceList('Just an answer ([x](https://x.example)).')).toBe('Just an answer ([x](https://x.example)).');
  });
});
