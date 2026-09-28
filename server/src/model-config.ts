export const MODEL_CONFIG = {
  triage: process.env.COPILOT_TRIAGE_MODEL || 'gpt-6-luna',
  agenda: process.env.COPILOT_AGENDA_MODEL || 'gpt-6-luna',
  // gpt-6-luna since 2026-09-22 (was gpt-5.6-terra, never compared against a
  // cheaper tier). Terra was 73% of a meeting's metered spend: 23 calls, $0.49
  // of $0.68 in the 09-21 Winslow call. `npm run eval:agenda` replays real
  // sessions through whatever this resolves to; set the env var to roll back.
  agendaReconcile: process.env.COPILOT_AGENDA_RECONCILE_MODEL || 'gpt-6-luna',
  // Luna, not Terra. `npm run eval:coach`, 3 runs each on the 10 frozen cases:
  // identical quality (100/100 score, 100% decision/schema/quality on every
  // run) while Luna is 10x cheaper ($0.00027 vs $0.0027 per coach call) and has
  // a far tighter tail — Terra's p95 swung 2.1s/4.5s/8.0s and cost it the
  // `usable` mark twice, both times by missing the deadline rather than by
  // giving bad advice. Luna's worst p95 over the same runs was 3.3s. That tail
  // is the same thing that binned 13% of real coach evaluations as stale.
  // gpt-6-luna since 2026-09-22: same eval, 100/100 again, p95 1.9s.
  coach: process.env.COPILOT_COACH_MODEL || 'gpt-6-luna',
  // Context compression (intelligence/compression.ts): the paragraph that
  // carries the meeting past triage's 5-minute window. Subscription Haiku
  // when the API is off.
  compression: process.env.COPILOT_COMPRESSION_MODEL || 'gpt-6-luna',
  fastResearch: process.env.COPILOT_RESEARCH_MODEL || 'gpt-6-luna',
  // Meeting chat (chat/service.ts): the drawer's back-and-forth, with the
  // meeting as context and web search. Metered, like fast research; the
  // subscription CLI (the worker model) answers when the API is off or fails.
  chat: process.env.COPILOT_CHAT_MODEL || 'gpt-6-luna',
  haiku: process.env.COPILOT_HAIKU_MODEL || 'claude-haiku-4-5-20251001',
  suggestion: process.env.COPILOT_SUGGEST_MODEL || process.env.COPILOT_SUGGESTION_MODEL || 'claude-sonnet-5-5',
  worker: process.env.COPILOT_WORKER_MODEL || 'claude-sonnet-5-5',
  // Deep research (workers/research.ts): an agent loop with WebSearch/WebFetch
  // on the subscription CLI, so depth matters more than latency or cost.
  // Chris's call 2026-09-22: Opus 5.5, not Sonnet. `npm run eval:research --
  // --provider deep` scores it.
  deepResearch: process.env.COPILOT_DEEP_RESEARCH_MODEL || 'claude-opus-5-5',
  // Pre-meeting prep agent (prep/agent.ts) — web research on the subscription CLI.
  prep: process.env.COPILOT_PREP_MODEL || 'claude-sonnet-5-5',
  // Opus 5.5 since 2026-09-28: cheaper than Opus 5 ($4/$20 vs $5/$25) and
  // stronger at the same effort. Runs on the subscription CLI.
  review: process.env.COPILOT_REVIEW_MODEL || 'claude-opus-5-5',
  // Meeting pulse (intelligence/pulse.ts): a big-picture read every 5 minutes on
  // the subscription CLI, so depth matters more than latency or cost. Chris's
  // call 2026-09-22: Opus 5.5, not Sonnet.
  pulse: process.env.COPILOT_PULSE_MODEL || 'claude-opus-5-5',
} as const;

export type CliEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// Effort for each role that runs on the `claude` CLI. Every spawn passes
// --effort, because without it the CLI inherits the effort in
// ~/.claude/settings.json: tuning the terminal silently retuned the app, and
// live suggestions ran on Sonnet 5.5 at xhigh. Chris's calls 2026-09-28:
// no Claude call below medium, prep at high (the best prep, still bounded),
// xhigh for the post-meeting self-review.
// Live suggestions stay at xhigh, the level they already ran at: replaying 18
// real trigger moments from 6 meetings, a blind Opus judge preferred xhigh
// over high 13-5, over medium 14-4 and over low 17-1. The lower levels lost on
// grounding (tasks for the wrong person, figures taken at face value, the
// asked-for format missed), not only on length. p50: xhigh 12.0 s, high
// 9.1 s, medium 7.6 s.
export const EFFORT_CONFIG = {
  suggestion: 'xhigh',
  worker: 'medium',
  prep: 'high',
  deepResearch: 'medium',
  pulse: 'medium',
  review: 'xhigh',
} as const satisfies Record<string, CliEffort>;

/**
 * The --effort args for a `claude` spawn. A caller that names no effort gets
 * `medium`. Haiku 4.5 has no effort control, and
 * with no model the CLI's own default model is unknown, so neither gets one.
 */
export function cliEffortArgs(model: string | undefined, effort?: CliEffort): string[] {
  if (!model || model.includes('haiku')) return [];
  return ['--effort', effort ?? 'medium'];
}

export type LlmTransportMode = 'api' | 'cli' | 'auto';

function transportMode(value: string | undefined): LlmTransportMode {
  return value === 'api' || value === 'cli' ? value : 'auto';
}

export const LLM_CONFIG = {
  liveTransport: transportMode(process.env.COPILOT_LIVE_LLM_MODE),
  workerTransport: transportMode(process.env.COPILOT_WORKER_LLM_MODE),
} as const;
