import { claudeSuggest } from '../claude-cli.js';
import {
  readReviews,
  appendReview,
  lastReview,
  summarizeTrend,
  type ReviewScores,
} from '../session/reviewStore.js';
import type { Worker, WorkerCapabilities, WorkerResult } from './types.js';

const SCORES_MARKER = '<!--SCORES-->';

const REVIEW_SYSTEM = `You are a candid but constructive executive coach. You review how ONE person — "You" / "[You]" in the transcript — performed in a meeting they just finished. The other participants are "[Meeting]". Assess the user only; do not critique the others.

Write a tight, specific scorecard in markdown with EXACTLY these sections:

## Self-Review — <meeting title>

**How you showed up:** one or two sentences, honest overall read.

### Strengths
- 2-4 concrete things the user did well, each tied to something specific they said.

### Areas to improve
- 2-4 concrete, actionable improvements. No fluff.

### Question handling
For each question that was directed at the user, quote it briefly and assess their answer:
- **Asked:** "..." — **You:** "<their answer, paraphrased>" — <was it direct/complete/evasive? how to do it better>
If no questions were directed at the user, say so in one line.

### Scores
- **Clarity:** N/5 — <one clause>
- **Decisiveness:** N/5 — <one clause>
- **Concision:** N/5 — <one clause>

### Next-meeting goals
1. <concrete goal>
2. <concrete goal>
3. <optional third>

Then, on the VERY LAST line and nowhere else, emit a machine-readable block:
${SCORES_MARKER}
{"clarity": N, "decisiveness": N, "concision": N, "goals": ["goal 1", "goal 2"]}

Rules: scores are integers 1-5 (1 poor, 5 excellent). The JSON goals must match your "Next-meeting goals" section. Output nothing after the JSON line.`;

export class ReviewWorker implements Worker {
  public readonly name = 'review';
  public readonly capabilities: WorkerCapabilities = {
    network: 'anthropic-only',
    filesystem: { read: [], write: ['~/.meeting-copilot/**'] },
    subprocess: false,
    // Generous safety cap (~15 min): jobs run until done or the user cancels.
    maxDurationMs: 900_000,
    maxMemoryMB: 100,
  };

  async execute(
    params: Record<string, any>,
    signal: AbortSignal,
  ): Promise<WorkerResult> {
    const transcript = params.transcript as string | undefined;
    const title = (params.title as string) || 'Untitled';
    const sessionId = (params.sessionId as string) || '';
    const micWords = Number(params.micWords) || 0;
    const meetingWords = Number(params.meetingWords) || 0;
    const agendaSummary = (params.agendaSummary as string) || '';
    const goals = (params.goals as string) || '';
    const factFlags = Array.isArray(params.factFlags)
      ? (params.factFlags as Array<{ claim: string; verdict: string; correction?: string }>)
      : [];

    if (!transcript || transcript.trim().length < 40) {
      return {
        success: false,
        data: null,
        summary: 'Not enough transcript to review',
        error: 'Transcript too short for a meaningful self-review',
      };
    }

    if (signal.aborted) {
      return { success: false, data: null, summary: 'Review cancelled before start', error: 'Aborted' };
    }

    // ── Derived stats fed to the model alongside the transcript ──
    const totalWords = micWords + meetingWords;
    const talkRatio = totalWords > 0 ? micWords / totalWords : 0;
    const talkPct = Math.round(talkRatio * 100);

    // Cheap heuristic: questions coming from the other side of the table.
    const questionsFromOthers = transcript
      .split('\n')
      .filter((l) => l.startsWith('[Meeting]') && l.includes('?')).length;

    const statsLines = [
      `Talk ratio: you spoke ${talkPct}% of the words (you: ${micWords}, others: ${meetingWords}).`,
      `Questions from others (contain "?"): ${questionsFromOthers}. Identify which were aimed at you and grade your answers.`,
      agendaSummary
        ? `Agenda coverage at meeting end:\n${agendaSummary}`
        : 'Agenda coverage: no agenda was set.',
      factFlags.length > 0
        ? `Fact-check flags against statements you made:\n${factFlags
            .map((f) => `- "${f.claim}" (${f.verdict})${f.correction ? ` — correction: ${f.correction}` : ''}`)
            .join('\n')}`
        : 'Fact-check flags against you: none.',
      goals ? `Your private goals going in:\n${goals}` : 'Your private goals going in: none provided.',
    ].join('\n');

    const userContent = `Meeting: ${title}\n\nDerived stats:\n${statsLines}\n\nFull transcript ("[You]" = the user, "[Meeting]" = others):\n\n${transcript}`;

    try {
      // CLI-only (subscription, no paid API): Sonnet via claudeSuggest.
      const raw = await claudeSuggest(userContent, REVIEW_SYSTEM, signal);

      if (signal.aborted) {
        return { success: false, data: null, summary: 'Review cancelled during execution', error: 'Aborted' };
      }

      const { markdown, scores, parsedGoals } = parseReview(raw);

      // ── Cross-meeting trend: compare against the most recent prior review ──
      const prior = lastReview();
      const priorCount = readReviews().length;
      const trendLine = scores ? summarizeTrend(prior, scores, priorCount) : '';

      // Persist this meeting's record so future reviews can show deltas.
      if (scores) {
        appendReview({
          date: new Date().toISOString(),
          title,
          sessionId,
          scores,
          goals: parsedGoals,
          talkRatio,
        });
      }

      const trendBlock = trendLine
        ? `> **Trend vs last meeting:** ${trendLine}\n\n`
        : prior
          ? ''
          : `> _First tracked meeting — trends will appear after your next review._\n\n`;

      const artifactMarkdown = `${trendBlock}${markdown}`;

      return {
        success: true,
        data: { scores, goals: parsedGoals, talkRatio, trend: trendLine },
        summary: `Self-review ready for: ${title}`,
        artifacts: [
          {
            type: 'markdown',
            content: artifactMarkdown,
            title: `Self-Review — ${title}`,
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        data: null,
        summary: `Self-review failed: ${message}`,
        error: message,
      };
    }
  }
}

/** Split the model output into display markdown + parsed scores/goals. */
function parseReview(raw: string): {
  markdown: string;
  scores: ReviewScores | null;
  parsedGoals: string[];
} {
  const idx = raw.indexOf(SCORES_MARKER);
  const markdown = (idx >= 0 ? raw.slice(0, idx) : raw).trim();
  const jsonPart = idx >= 0 ? raw.slice(idx + SCORES_MARKER.length) : raw;

  let scores: ReviewScores | null = null;
  let parsedGoals: string[] = [];
  const start = jsonPart.indexOf('{');
  const end = jsonPart.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(jsonPart.slice(start, end + 1));
      scores = {
        clarity: clampScore(obj.clarity),
        decisiveness: clampScore(obj.decisiveness),
        concision: clampScore(obj.concision),
      };
      if (Array.isArray(obj.goals)) {
        parsedGoals = obj.goals.map((g: unknown) => String(g)).filter(Boolean).slice(0, 3);
      }
    } catch {
      scores = null;
    }
  }
  return { markdown, scores, parsedGoals };
}

function clampScore(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n));
}
