/**
 * Local project matching for the start form — no model, no network.
 *
 * Deliberately not an LLM call. Per the Jev decision note
 * (`~/Documents/CX/Resources/AI & Tooling/Jev.md` § *Jev vs a trained
 * classifier*), the first question on anything classification-shaped is whether
 * it beats NO model. Here it doesn't: project names are literal strings and a
 * meeting title usually contains one, so token overlap answers it in
 * microseconds, for nothing, with the meeting title — which carries client and
 * attendee names — never leaving the machine.
 *
 * Measured against the ten recorded sessions: 7 of 8 distinct titles matched
 * correctly, the miss being "Northwind" alone, which is genuinely ambiguous between
 * `cxventures` and `northwind-course-studio` and belongs to the human.
 */
import type { ProjectInfo } from './index.js';

/**
 * Meeting vocabulary. These words say nothing about WHICH project a meeting is
 * about, and matching on them is actively wrong: "Globex Portal Meeting" scored
 * `meeting-copilot` at 0.5 before this list existed.
 */
const STOPWORDS = new Set([
  'meeting', 'meet', 'sync', 'syncup', 'call', 'chat', 'talk', 'catch', 'catchup',
  'standup', 'huddle', 'review', 'check', 'checkin', 'touchbase', 'touch', 'base',
  'weekly', 'daily', 'monthly', 'quarterly', 'biweekly',
  'with', 'and', 'the', 'for', 'about', 'on', 'in', 'at', 'to', 'of', 'a', 'an',
  'demo', 'intro', 'kickoff', 'kick', 'off', 'followup', 'follow', 'up', 'next',
  'session', 'discussion', 'convo', 'conversation', 'update', 'notes', 'agenda',
]);

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface ProjectMatch {
  name: string;
  path: string;
  category: ProjectInfo['category'];
  /** 0..1. 1 means the project's own name appears in the text. */
  score: number;
}

/**
 * Suggest projects for a meeting title / agenda.
 *
 * `minScore` is the floor for a suggestion the UI will act on. It sits at 0.5
 * because the real corpus separates cleanly: correct matches score 1.0 and the
 * one ambiguous case scores 0.33. A wrong pre-fill costs more than no pre-fill,
 * so the middle band is left to the human.
 */
export function suggestProjects(
  text: string,
  projects: ProjectInfo[],
  options: { minScore?: number; limit?: number } = {},
): ProjectMatch[] {
  const minScore = options.minScore ?? 0.5;
  const limit = options.limit ?? 3;
  const raw = (text ?? '').trim();
  if (!raw) return [];

  const textTokens = new Set(tokens(raw).filter((t) => !STOPWORDS.has(t)));
  const textSquashed = squash(raw);
  if (textTokens.size === 0 && !textSquashed) return [];

  const matches: ProjectMatch[] = [];
  for (const project of projects) {
    const nameTokens = tokens(project.name).filter((t) => !STOPWORDS.has(t));
    if (nameTokens.length === 0) continue;

    // "AI Media" -> aimedia: the project name, separators removed, appearing in
    // the title with its separators removed too.
    const nameSquashed = squash(project.name);
    let score = 0;
    if (nameSquashed.length >= 3 && textSquashed.includes(nameSquashed)) {
      score = 1;
    } else {
      const hits = nameTokens.filter((t) => textTokens.has(t)).length;
      score = hits / nameTokens.length;
    }

    if (score >= minScore) {
      matches.push({ name: project.name, path: project.path, category: project.category, score });
    }
  }

  return matches
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Filter for the autocomplete input itself — substring on the name, so typing
 * "meet" narrows to meeting-copilot. Empty query returns everything, which is
 * what keeps "browse the whole list" available.
 */
export function filterProjects(query: string, projects: ProjectInfo[]): ProjectInfo[] {
  const q = squash(query);
  if (!q) return projects;
  return projects.filter((p) => squash(p.name).includes(q));
}
