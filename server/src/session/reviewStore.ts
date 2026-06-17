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

/** Append one record, atomically (write tmp → rename). Best-effort. */
export function appendReview(record: ReviewRecord): void {
  try {
    if (!existsSync(BASE_DIR)) mkdirSync(BASE_DIR, { recursive: true });
    const all = readReviews();
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

/** The most recent prior review (excluding the one being written), or null. */
export function lastReview(): ReviewRecord | null {
  const all = readReviews();
  return all.length > 0 ? all[all.length - 1]! : null;
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
