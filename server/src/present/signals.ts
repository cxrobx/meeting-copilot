/**
 * Transcript signal detection (action / decision / risk / question tags).
 *
 * Matching is word-boundary anchored — the old bare `includes()` tagged
 * "brisk" as a risk and "transaction" as an action. The marker lists live
 * here so they are testable; the dashboard template injects the compiled
 * regex sources (see PRESENT_HTML) and runs the same logic client-side.
 */

export const ACTION_MARKERS = [
  'action item', 'follow up', 'next step', 'send', 'share', 'create', 'draft',
  'schedule', 'update', 'write', 'review', 'prepare', 'need to', "let's",
  'we should', "i'll", 'i will', 'can you', 'could you', 'own that', 'take that',
];

export const DECISION_MARKERS = [
  'we decided', 'decision', 'agreed', 'approved', "we'll go with", "let's do",
  'locking', 'move forward with', 'ship this', 'finalize',
];

export const BLOCKER_MARKERS = [
  'blocker', 'blocked', 'risk', 'concern', 'issue', 'problem', "can't",
  'cannot', 'stuck', 'delay', 'slip', 'waiting on',
];

export const QUESTION_STARTS = [
  'what', 'why', 'how', 'when', 'where', 'who', 'should', 'can', 'could',
  'would', 'do we', 'are we',
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markersToSource(markers: string[]): string {
  return `\\b(?:${markers.map(escapeRegex).join('|')})\\b`;
}

/** Regex sources (not RegExp objects — these are serialized into the page). */
export function buildSignalRegexSources(): { action: string; decision: string; risk: string } {
  return {
    action: markersToSource(ACTION_MARKERS),
    decision: markersToSource(DECISION_MARKERS),
    risk: markersToSource(BLOCKER_MARKERS),
  };
}

/** Server-side mirror of the dashboard's detector — exists for tests. */
export function detectSignals(text: string): string[] {
  const sources = buildSignalRegexSources();
  const signals: string[] = [];
  if (new RegExp(sources.action, 'i').test(text)) signals.push('action');
  if (new RegExp(sources.decision, 'i').test(text)) signals.push('decision');
  if (new RegExp(sources.risk, 'i').test(text)) signals.push('risk');
  if (text.includes('?')) {
    const lower = text.toLowerCase();
    for (const start of QUESTION_STARTS) {
      if (lower.startsWith(start) || lower.includes(` ${start} `)) {
        signals.push('question');
        break;
      }
    }
  }
  return signals;
}
