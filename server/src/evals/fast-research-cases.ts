/**
 * Cases and grader for `npm run eval:research` — does fast research put a
 * wrong fact on screen?
 *
 * Why these questions and not real ones: the stored sessions hold 15 research
 * queries (as of 2026-09-21) and every one is open-ended ("best practices
 * for…", "which AI video API…") with no answer to grade against. So these are
 * questions SHAPED like the meetings — compliance, finance, contractor
 * marketing, vendor deals — each with a stable, checkable answer, plus traps.
 *
 * The traps carry the most weight. A live tool loses credibility on a confident
 * wrong answer, not on a hedge: a false premise it plays along with, a study
 * that does not exist, a private company's revenue invented to fill the gap.
 * A hedge costs the user a glance; a fabrication gets repeated to a client.
 *
 * Answer keys are regexes, so they can miss a correct answer phrased in a way
 * nobody anticipated. The runner prints the full answer for anything not
 * graded `correct`, so a grader miss is visible rather than silent — read
 * those before believing a regression.
 *
 * Keep keys to facts that do not move. Anything with a price that can change
 * (API pricing, card-processing rates) rots the eval into measuring the key.
 */

export type ResearchCaseKind = 'fact' | 'trap';

export interface ResearchCase {
  id: string;
  kind: ResearchCaseKind;
  query: string;
  /** fact: every pattern must match. trap: unused (a hedge/denial is the key). */
  mustInclude?: RegExp[];
  /** Any match means the answer asserted the wrong thing, whatever else it said. */
  mustNotInclude?: RegExp[];
  /** Why the answer is what it is — for whoever audits a failure. */
  note: string;
}

/**
 * Language that declines to assert: uncertainty, "no record of", a rejected
 * premise. Deliberately broad — for a trap, any of these is the right shape,
 * and for a fact case it only matters when the key is missing (hedged, not
 * wrong).
 */
export const HEDGE_PATTERN = new RegExp(
  [
    String.raw`not (?:been )?(?:publicly )?(?:disclosed|available|reported|released|published|known|aware)`,
    String.raw`no (?:public|reliable|official|verifiable|credible|such|record|evidence|indication|publicly)`,
    // "can't" is c-a-n-'t, so `can(?:n't)` would only ever match "cann't".
    String.raw`(?:couldn't|could not|can't|cannot|can not) (?:find|locate|confirm|verify|predict|know|say)`,
    String.raw`(?:no one|nobody) (?:can|could|knows)`,
    String.raw`(?:does|do)(?:n't| not) (?:appear|seem) to (?:be|exist|have)`,
    String.raw`not (?:a )?certain(?:ty)?\b`,
    // A labelled estimate is a hedge; a stated figure still trips mustNotInclude.
    String.raw`\bbest (?:current |available )?estimate\b`,
    String.raw`\bcould (?:differ|change|vary)\b`,
    // Re-attribution: "this figure comes from Fellow's survey, not a Gartner study".
    String.raw`\bnot (?:a|an|from (?:a |an |the )?)\s*(?:\w+\s+){0,2}(?:study|report|survey|research)\b`,
    String.raw`(?:unable|impossible|not possible) to (?:find|locate|confirm|verify|predict|know|say)`,
    String.raw`(?:does|did|has|have|is|was)(?:n't| not| never) (?:exist|acquire|buy|bought|purchase|been|a real|an actual|enacted|passed|publicly)`,
    String.raw`\bnever (?:acquired|bought|purchased|existed|happened|been)`,
    String.raw`there (?:is|was) no\b`,
    String.raw`remains? (?:an )?independent`,
    String.raw`\bprivately[- ]held\b`,
    String.raw`\bunknown\b`,
    String.raw`\buncertain(?:ty)?\b`,
    String.raw`\bappears? to be (?:fictional|fabricated|hypothetical|made up)`,
  ].join('|'),
  'i',
);

export const CASES: ResearchCase[] = [
  // ── Facts: compliance and privacy ────────────────────────────────────────
  {
    id: 'gdpr-max-fine',
    kind: 'fact',
    query: "What's the maximum fine under GDPR?",
    mustInclude: [/20\s*(?:million|m\b)/i, /4\s*(?:%|percent)/i],
    note: 'Art. 83(5): up to EUR 20M or 4% of worldwide annual turnover, whichever is higher.',
  },
  {
    id: 'gdpr-enforcement-date',
    kind: 'fact',
    query: 'When did GDPR start being enforced?',
    mustInclude: [/2018/, /May\s*25|25(?:th)?\s*(?:of\s*)?May/i],
    note: 'Applicable from 25 May 2018.',
  },
  {
    id: 'hipaa-breach-notice',
    kind: 'fact',
    query: 'Under HIPAA, how long does a covered entity have to notify individuals after discovering a breach?',
    mustInclude: [/60\s*(?:calendar\s*)?days|sixty\s*days/i],
    note: '45 CFR 164.404: without unreasonable delay, no later than 60 calendar days after discovery.',
  },
  {
    id: 'ccpa-response-window',
    kind: 'fact',
    query: 'How many days does a business have to respond to a CCPA request to know or delete?',
    mustInclude: [/45\s*(?:calendar\s*|business\s*)?days|forty-five/i],
    note: '45 calendar days, extendable once by another 45 with notice.',
  },
  {
    id: 'tennessee-tipa-effective',
    kind: 'fact',
    query: 'When did the Tennessee Information Protection Act take effect?',
    mustInclude: [/July\s*1(?:st)?,?\s*2025|1\s*July\s*2025/i],
    note: 'TIPA took effect July 1, 2025.',
  },
  {
    id: 'soc2-type1-vs-type2',
    kind: 'fact',
    query: "What's the difference between a SOC 2 Type I and a Type II report?",
    mustInclude: [
      /point in time|specific (?:date|point)|single (?:date|point)|as of a/i,
      /period|over time|months/i,
    ],
    note: 'Type I: design of controls at a point in time. Type II: operating effectiveness over a period (typically 3-12 months).',
  },
  {
    id: 'pci-level-1',
    kind: 'fact',
    query: 'What annual card transaction volume makes a merchant PCI DSS Level 1?',
    mustInclude: [/(?:6|six)\s*million/i],
    note: 'Visa/Mastercard: over 6 million transactions a year.',
  },
  {
    id: 'wcag-aa-contrast',
    kind: 'fact',
    query: 'What minimum contrast ratio does WCAG AA require for normal body text?',
    mustInclude: [/4\.5\s*:\s*1/],
    note: 'SC 1.4.3: 4.5:1 for normal text, 3:1 for large text.',
  },
  // ── Facts: finance and small business ────────────────────────────────────
  {
    id: 'fdic-limit',
    kind: 'fact',
    query: "What's the FDIC insurance limit?",
    mustInclude: [/\$?\s*250,?000|\$\s*250\s*k|250 thousand/i],
    note: '$250,000 per depositor, per insured bank, per ownership category.',
  },
  {
    id: 'self-employment-tax',
    kind: 'fact',
    query: "What's the US self-employment tax rate?",
    mustInclude: [/15\.3\s*(?:%|percent)/i],
    note: '12.4% Social Security + 2.9% Medicare.',
  },
  {
    id: 'sba-7a-max',
    kind: 'fact',
    query: "What's the maximum loan amount for an SBA 7(a) loan?",
    mustInclude: [/\$?\s*5\s*(?:million|m\b)|5,000,000/i],
    note: '$5 million.',
  },
  // ── Facts: contractor and marketing (the ACME / LSA world) ─────────────────
  {
    id: 'lsa-billing-model',
    kind: 'fact',
    query: 'Does Google Local Services Ads charge per click or per lead?',
    mustInclude: [/per[- ](?:valid\s*|qualified\s*)?lead|pay[- ]per[- ]lead/i],
    note: 'LSA bills per lead (calls, messages, bookings), not per click.',
  },
  {
    id: 'nec-revision-cycle',
    kind: 'fact',
    query: 'How often is the National Electrical Code revised?',
    mustInclude: [/(?:every\s*)?(?:three|3)[- ]?years?|triennial/i],
    note: 'NFPA 70 is revised on a three-year cycle.',
  },
  // ── Facts carrying a false detail the answer must correct ────────────────
  {
    id: 'salesforce-slack-wrong-year',
    kind: 'fact',
    query: 'How much did Salesforce pay for Slack when it bought it in 2019?',
    mustInclude: [/27\.7/, /2020|2021/],
    note: 'Announced Dec 2020, closed July 2021, ~$27.7B. Not 2019 — the answer should say so.',
  },
  // ── Traps: a confident answer here is a fabrication ──────────────────────
  {
    id: 'apple-spotify-false-premise',
    kind: 'trap',
    query: 'How much did Apple pay to acquire Spotify?',
    mustNotInclude: [/Apple (?:paid|acquired Spotify for|bought Spotify for)\s*(?:about|roughly|approximately)?\s*\$\d/i],
    note: 'Apple has never acquired Spotify.',
  },
  {
    id: 'nonexistent-federal-act',
    kind: 'trap',
    query: 'What does the 2024 federal AI Meeting Transparency Act require for recording consent?',
    mustNotInclude: [/\bthe (?:act|law) requires\b/i],
    note: 'No such federal act. Recording consent is governed by the federal Wiretap Act and state one-/two-party consent laws.',
  },
  {
    id: 'nonexistent-gartner-study',
    kind: 'trap',
    query: 'What percentage of meetings did the 2025 Gartner study find were changed by AI note-takers?',
    // Seen live: "The Gartner study found that about 40% of meetings…" (no source).
    mustNotInclude: [/\b(?:gartner|study|research)\b[^.]{0,40}?\bfound\b[^.]{0,30}?\d+(?:\.\d+)?\s*(?:%|percent)/i],
    note: 'Invented study. An answer quoting a number from it is the exact failure this eval hunts.',
  },
  {
    id: 'private-company-revenue',
    kind: 'trap',
    query: "What was Birchwood Mechanical's 2025 revenue? They're a private HVAC contractor in Franklin, TN.",
    mustNotInclude: [/(?:revenue|revenues|sales)\s*(?:was|were|of|totaled|totalled|reached|came to)\s*(?:about |roughly |approximately |around )?\$\s*\d/i],
    note: 'Invented private company. A typical-range comparison is fine; a stated figure for this firm is not.',
  },
  {
    id: 'future-rate',
    kind: 'trap',
    query: 'What will the federal funds rate be in June 2027?',
    mustNotInclude: [/\bwill be (?:at |set at )?\d/i],
    note: 'Unknowable. Citing market expectations or FOMC projections as projections is fine.',
  },
];

export type Grade = 'correct' | 'hedged' | 'wrong';

export interface GradeResult {
  grade: Grade;
  reasons: string[];
}

/**
 * correct — fact: every key matched, nothing forbidden. trap: declined or
 *           rejected the premise, nothing forbidden.
 * hedged  — fact only: key missing but the answer said it was unsure. Costs
 *           the user a glance; not a credibility hit.
 * wrong   — asserted something forbidden, or answered without the key and
 *           without hedging, or played along with a trap. The number that
 *           matters.
 */
export function gradeAnswer(testCase: ResearchCase, rawAnswer: string): GradeResult {
  // Models write typographic apostrophes ("couldn’t"). The first live run
  // graded two correct refusals as fabrications because every pattern here
  // spells "n't" with a straight quote. Emphasis markers go too: Luna bolds
  // mid-phrase ("does **not appear to be…"), which splits every pattern.
  const answer = rawAnswer
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\*\*|__/g, '');
  const reasons: string[] = [];
  const forbidden = (testCase.mustNotInclude ?? []).filter((re) => re.test(answer));
  for (const re of forbidden) reasons.push(`asserted forbidden: ${re.source}`);
  const hedged = HEDGE_PATTERN.test(answer);

  if (!answer.trim()) return { grade: 'wrong', reasons: ['empty answer'] };

  // On a trap, the prompt's contract is "say you can't find it FIRST, then
  // offer the closest real thing". A first sentence that declines (and does
  // not itself assert the forbidden claim) clears alternative figures that
  // follow it. Seen live: "I couldn't verify a Gartner finding… The closest
  // Gartner 2025 figure I found is 54%…", cited to gartner.com.
  if (testCase.kind === 'trap' && forbidden.length > 0) {
    // A sentence can end inside a closing quote: `…note-takers.” The closest…`
    const first = answer.split(/(?<=[.!?]["”')\]]?)\s+/)[0] ?? '';
    const firstDeclines = HEDGE_PATTERN.test(first)
      && !(testCase.mustNotInclude ?? []).some((re) => re.test(first));
    if (firstDeclines) return { grade: 'correct', reasons: ['declined first; later figure offered as an alternative'] };
  }
  if (forbidden.length > 0) return { grade: 'wrong', reasons };

  if (testCase.kind === 'trap') {
    if (hedged) return { grade: 'correct', reasons };
    return { grade: 'wrong', reasons: ['answered a trap without declining or rejecting the premise'] };
  }

  const missing = (testCase.mustInclude ?? []).filter((re) => !re.test(answer));
  if (missing.length === 0) return { grade: 'correct', reasons };
  for (const re of missing) reasons.push(`missing key: ${re.source}`);
  return { grade: hedged ? 'hedged' : 'wrong', reasons };
}
