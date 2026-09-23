/**
 * Citations for research answers: every research path returns the same
 * `sources` shape, and every answer is checked for findings credited to a
 * named source it never cited.
 *
 * Why the check exists: asked what a nonexistent 2025 Gartner study found,
 * Luna answered with a statistic credited to "the 2025 Gartner study" in
 * 5 runs out of 5, sourced to a vendor blog or to nothing. A prompt rule cut
 * that to ~2 in 8 but cannot make it zero. This check can, for the named
 * sources it knows: it costs no model call and no latency, and it runs on
 * the answer the user actually sees.
 */

export interface ResearchSource {
  url: string;
  title: string;
}

export interface UnverifiedAttribution {
  /** Who the answer credited: "Gartner", or "a study" for an unnamed one. */
  source: string;
  /** The sentence that made the claim, trimmed for display. */
  sentence: string;
}

/**
 * Research firms, publishers and institutions a meeting answer tends to
 * credit, with the domains their own publications live on. Add to this when
 * a real answer credits someone missing here — the eval's printed failures
 * are where those show up.
 */
const NAMED_SOURCES: Array<{ name: string; pattern: RegExp; domains: string[] }> = [
  { name: 'Gartner', pattern: /\bGartner\b/, domains: ['gartner.com'] },
  { name: 'Forrester', pattern: /\bForrester\b/, domains: ['forrester.com'] },
  { name: 'McKinsey', pattern: /\bMcKinsey\b/, domains: ['mckinsey.com'] },
  { name: 'Deloitte', pattern: /\bDeloitte\b/, domains: ['deloitte.com'] },
  { name: 'PwC', pattern: /\bPwC\b|\bPricewaterhouseCoopers\b/, domains: ['pwc.com'] },
  { name: 'BCG', pattern: /\bBCG\b|\bBoston Consulting Group\b/, domains: ['bcg.com'] },
  { name: 'Bain', pattern: /\bBain(?: & Company)?\b/, domains: ['bain.com'] },
  { name: 'Accenture', pattern: /\bAccenture\b/, domains: ['accenture.com'] },
  { name: 'IDC', pattern: /\bIDC\b/, domains: ['idc.com'] },
  { name: 'Pew Research', pattern: /\bPew\b/, domains: ['pewresearch.org'] },
  { name: 'Harvard Business Review', pattern: /\bHarvard Business Review\b|\bHBR\b/, domains: ['hbr.org'] },
  { name: 'Statista', pattern: /\bStatista\b/, domains: ['statista.com'] },
  { name: 'Nielsen', pattern: /\bNielsen\b/, domains: ['nielsen.com'] },
  { name: 'Microsoft Work Trend Index', pattern: /\bWork Trend Index\b/, domains: ['microsoft.com'] },
  { name: 'Stanford AI Index', pattern: /\bAI Index\b/, domains: ['stanford.edu'] },
];

// A clause that credits a finding: "according to X", "X found/reports/…",
// "X's 2025 survey shows". Matched per sentence, after the named source.
const ATTRIBUTION_VERB =
  /\b(?:found|finds|shows?|showed|says|said|reports?|reported|estimates?|estimated|predicts?|predicted|projects?|projected|revealed|concluded|notes?|noted|surveyed)\b/i;
const ACCORDING_TO = /\baccording to\b/i;

// The sentence declines rather than asserts ("I couldn't find a 2025 Gartner
// study") — naming the source there is the right answer, not a claim.
const DECLINE =
  /(?:couldn't|could not|can't|cannot|unable to)\s+(?:find|locate|verify|confirm)|\bno (?:such|record|evidence|public)\b|\bnot aware of\b|\bdoes(?:n't| not) (?:appear|seem) to exist\b|\bthere is no\b/i;

// An unnamed study/survey credited with a finding.
const UNNAMED_STUDY =
  /\b(?:a|the|one|recent|new)\s+(?:\d{4}\s+)?(?:study|survey|report|poll|analysis)\b[^.]{0,80}?\b(?:found|finds|shows?|showed|revealed|reported)\b/i;

function sentences(text: string): string[] {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\*\*|__/g, '')
    .split(/(?<=[.!?]["”')\]]?)\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function citesDomain(sources: ResearchSource[], domains: string[]): boolean {
  return sources.some((s) => {
    const host = hostOf(s.url);
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  });
}

/**
 * Sentences that credit a named source none of the citations come from, and
 * — when nothing is cited at all — sentences crediting an unnamed study.
 */
export function checkAttributions(answer: string, sources: ResearchSource[]): UnverifiedAttribution[] {
  const out: UnverifiedAttribution[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences(answer)) {
    if (DECLINE.test(sentence)) continue;
    for (const named of NAMED_SOURCES) {
      const m = named.pattern.exec(sentence);
      if (!m) continue;
      const after = sentence.slice(m.index);
      const credits = ACCORDING_TO.test(sentence) || ATTRIBUTION_VERB.test(after);
      if (!credits || citesDomain(sources, named.domains) || seen.has(named.name)) continue;
      seen.add(named.name);
      out.push({ source: named.name, sentence: sentence.slice(0, 200) });
    }
    if (sources.length === 0 && UNNAMED_STUDY.test(sentence) && !seen.has('a study')) {
      seen.add('a study');
      out.push({ source: 'a study', sentence: sentence.slice(0, 200) });
    }
  }
  return out;
}

const URL_RE = /https?:\/\/[^\s)\]}"'<>]+/g;

/**
 * Sources from answer text, for the paths with no structured citations (the
 * `claude` CLI). Prefers markdown link titles; dedupes; drops the
 * `utm_source` noise OpenAI appends.
 */
export function extractUrlSources(text: string, limit = 8): ResearchSource[] {
  const out: ResearchSource[] = [];
  const seen = new Set<string>();
  const add = (rawUrl: string, title: string) => {
    const url = rawUrl.replace(/[.,;:]+$/, '').replace(/[?&]utm_source=openai$/, '');
    if (seen.has(url) || out.length >= limit) return;
    seen.add(url);
    out.push({ url, title: title || hostOf(url) || url });
  };
  for (const m of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) add(m[2]!, m[1]!);
  for (const m of text.matchAll(URL_RE)) add(m[0], '');
  return out;
}

/**
 * The answer without a sources list the model wrote at its end. Deep research
 * (the `claude` CLI) usually ends with its own "Sources:" list, and the
 * card's footer then printed every source twice. The links survive: sources
 * are extracted before this runs, and the footer lists them.
 */
export function stripSourceList(answer: string): string {
  const m = /\n(?:[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?Sources?:?(?:\*\*)?:?[ \t]*\n)(?:[ \t]*(?:[-*]|\d+[.)]|\[\d+\])[ \t]+.*(?:\n|$)|[ \t]*\n)+\s*$/i.exec(answer);
  return m ? answer.slice(0, m.index).trimEnd() : answer;
}

/** Markdown appended to a research card: the warning (if any), then sources. */
export function citationFooter(sources: ResearchSource[], unverified: UnverifiedAttribution[]): string {
  const parts: string[] = [];
  if (unverified.length > 0) {
    const names = unverified.map((u) => (u.source === 'a study' ? 'an unnamed study' : u.source)).join(', ');
    parts.push(`> ⚠ **Source not verified:** this answer credits ${names}, but none of its citations come from ${unverified.length > 1 ? 'them' : 'it'}. Treat that figure as unconfirmed.`);
  }
  if (sources.length > 0) {
    parts.push(`**Sources**\n${sources.map((s, i) => `[${i + 1}] [${s.title || s.url}](${s.url})`).join('\n')}`);
  } else {
    parts.push('_No sources cited — answered from model knowledge._');
  }
  return `\n\n---\n${parts.join('\n\n')}`;
}
