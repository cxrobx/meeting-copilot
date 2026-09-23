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
  haiku: process.env.COPILOT_HAIKU_MODEL || 'claude-haiku-4-5-20251001',
  suggestion: process.env.COPILOT_SUGGEST_MODEL || process.env.COPILOT_SUGGESTION_MODEL || 'claude-sonnet-5',
  worker: process.env.COPILOT_WORKER_MODEL || 'claude-sonnet-5',
  // Deep research (workers/research.ts): an agent loop with WebSearch/WebFetch
  // on the subscription CLI, so depth matters more than latency or cost.
  // Chris's call 2026-09-22: Opus 5.5, not Sonnet. `npm run eval:research --
  // --provider deep` scores it.
  deepResearch: process.env.COPILOT_DEEP_RESEARCH_MODEL || 'claude-opus-5-5',
  // Pre-meeting prep agent (prep/agent.ts) — web research on the subscription CLI.
  prep: process.env.COPILOT_PREP_MODEL || 'claude-sonnet-5',
  review: process.env.COPILOT_REVIEW_MODEL || 'claude-opus-5',
  // Meeting pulse (intelligence/pulse.ts): a big-picture read every 5 minutes on
  // the subscription CLI, so depth matters more than latency or cost. Chris's
  // call 2026-09-22: Opus 5.5, not Sonnet.
  pulse: process.env.COPILOT_PULSE_MODEL || 'claude-opus-5-5',
} as const;

export type LlmTransportMode = 'api' | 'cli' | 'auto';

function transportMode(value: string | undefined): LlmTransportMode {
  return value === 'api' || value === 'cli' ? value : 'auto';
}

export const LLM_CONFIG = {
  liveTransport: transportMode(process.env.COPILOT_LIVE_LLM_MODE),
  workerTransport: transportMode(process.env.COPILOT_WORKER_LLM_MODE),
} as const;
