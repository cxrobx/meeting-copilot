import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE_DIR = join(homedir(), '.meeting-copilot');
const REVIEWS_FILE = join(BASE_DIR, 'reviews.json');

export interface ReviewScores {
  clarity: number; // 1-5
  decisiveness: number; // 1-5
  concision: number; // 1-5
}

export interface ReviewRecord {
  date: string; // ISO-8601
  title: string;
  sessionId: string;
  scores: ReviewScores;
  goals: string[];
  talkRatio?: number; // 0-1, mic share of words
}

/** Read all prior review records. Returns [] when the file is missing/corrupt. */
export function readReviews(): ReviewRecord[] {
  try {
    if (!existsSync(REVIEWS_FILE)) return [];
    const parsed = JSON.parse(readFileSync(REVIEWS_FILE, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as ReviewRecord[]) : [];
  } catch {
    return [];
  }
}

/**
 * Append one record, atomically (write tmp → rename). Best-effort.
 * Records are keyed by `sessionId`: re-reviewing the same meeting (e.g. from
 * the past-meetings "Review" button) REPLACES its prior record rather than
 * appending a duplicate, so cross-meeting trends never double-count one session.
 */
export function appendReview(record: ReviewRecord): void {
  try {
    if (!existsSync(BASE_DIR)) mkdirSync(BASE_DIR, { recursive: true });
    const all = record.sessionId
      ? readReviews().filter((r) => r.sessionId !== record.sessionId)
      : readReviews();
    all.push(record);
    const tmp = `${REVIEWS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf-8');
    renameSync(tmp, REVIEWS_FILE);
  } catch (err) {
    console.warn(
      '[ReviewStore] Failed to append review:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * The most recent prior review, or null. Pass the current session's id to
 * EXCLUDE its own record — otherwise re-reviewing the latest meeting compares it
 * against itself (its prior record is the last element). "Prior" = a different
 * meeting reviewed before this one.
 */
export function lastReview(excludeSessionId?: string): ReviewRecord | null {
  const all = readReviews();
  const pool = excludeSessionId ? all.filter((r) => r.sessionId !== excludeSessionId) : all;
  return pool.length > 0 ? pool[pool.length - 1]! : null;
}

const arrow = (delta: number): string => (delta > 0 ? '↑' : delta < 0 ? '↓' : '→');

/**
 * One-line trend summary comparing the current scores against the most recent
 * prior review. Returns '' when there is no prior history.
 */
export function summarizeTrend(prev: ReviewRecord | null, current: ReviewScores, priorCount: number): string {
  if (!prev) return '';
  const parts = [
    `Clarity ${prev.scores.clarity}→${current.clarity} ${arrow(current.clarity - prev.scores.clarity)}`,
    `Decisiveness ${prev.scores.decisiveness}→${current.decisiveness} ${arrow(current.decisiveness - prev.scores.decisiveness)}`,
    `Concision ${prev.scores.concision}→${current.concision} ${arrow(current.concision - prev.scores.concision)}`,
  ];
  return `${parts.join(' · ')} (vs "${prev.title || 'last meeting'}", ${priorCount} prior review${priorCount === 1 ? '' : 's'})`;
}

export interface StandingGoals {
  /** Goal lines for the start form, which feed the coach's prompt. */
  goals: string[];
  /** Why each goal is there, in the same order — shown under the field. */
  evidence: string[];
  reviewed: number;
}

// Canonical wording per weak score. The reviews' own goals are too specific to
// carry forward ("Open Monday's call by proposing one first-version
// pipeline…"); what recurs across them is the dimension.
const DIMENSION_GOALS: Array<[keyof ReviewScores, string]> = [
  ['concision', 'Answer the question in your first sentence, then expand.'],
  ['clarity', 'Finish one thought before starting the next; park tangents out loud.'],
  ['decisiveness', 'Lead with a recommendation, not a menu of options.'],
];
const TALK_SHARE_LIMIT = 0.55;
const NEXT_STEP_RE = /next step|next action|owners?\b|close with|before the call ends|end (?:with|every)/i;

/**
 * What the last few self-reviews keep saying, as goals for the next meeting.
 *
 * Deterministic, no model: a dimension scored 2/5 or lower in at least half
 * the window, a talk share over 55% in at least half, and a missing next step
 * named in the goals of at least two. One review is a meeting, not a pattern,
 * so fewer than two returns null. On 2026-09-22's six reviews this gives
 * concision (4 of the last 5), talk share (3 of 5) and next step (4 of 5).
 */
export function standingGoals(all: ReviewRecord[] = readReviews(), window = 5): StandingGoals | null {
  const recent = all.slice(-window);
  if (recent.length < 2) return null;
  const half = Math.ceil(recent.length / 2);
  const goals: string[] = [];
  const evidence: string[] = [];

  for (const [dimension, goal] of DIMENSION_GOALS) {
    const weak = recent.filter((r) => typeof r.scores?.[dimension] === 'number' && r.scores[dimension] <= 2).length;
    if (weak >= half) {
      goals.push(goal);
      evidence.push(`${dimension} 2/5 or lower in ${weak} of ${recent.length}`);
    }
  }

  const ratios = recent.map((r) => r.talkRatio).filter((x): x is number => typeof x === 'number');
  const heavy = ratios.filter((x) => x > TALK_SHARE_LIMIT).length;
  if (ratios.length >= 2 && heavy >= Math.ceil(ratios.length / 2)) {
    goals.push('Keep your share of the talking under half: ask, then listen.');
    evidence.push(`talk share over ${Math.round(TALK_SHARE_LIMIT * 100)}% in ${heavy} of ${ratios.length}`);
  }

  const closes = recent.filter((r) => (r.goals ?? []).some((g) => NEXT_STEP_RE.test(g))).length;
  if (closes >= 2) {
    goals.push('Before it ends, name one next step with an owner and a date.');
    evidence.push(`no clear next step in ${closes} of ${recent.length}`);
  }

  return goals.length > 0 ? { goals, evidence, reviewed: recent.length } : null;
}
