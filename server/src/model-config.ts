export const MODEL_CONFIG = {
  triage: process.env.COPILOT_TRIAGE_MODEL || 'gpt-5.6-luna',
  agenda: process.env.COPILOT_AGENDA_MODEL || 'gpt-5.6-luna',
  agendaReconcile: process.env.COPILOT_AGENDA_RECONCILE_MODEL || 'gpt-5.6-terra',
  // Luna, not Terra. `npm run eval:coach`, 3 runs each on the 10 frozen cases:
  // identical quality (100/100 score, 100% decision/schema/quality on every
  // run) while Luna is 10x cheaper ($0.00027 vs $0.0027 per coach call) and has
  // a far tighter tail — Terra's p95 swung 2.1s/4.5s/8.0s and cost it the
  // `usable` mark twice, both times by missing the deadline rather than by
  // giving bad advice. Luna's worst p95 over the same runs was 3.3s. That tail
  // is the same thing that binned 13% of real coach evaluations as stale.
  coach: process.env.COPILOT_COACH_MODEL || 'gpt-5.6-luna',
  geminiTriage: process.env.COPILOT_GEMINI_TRIAGE_MODEL || 'gemini-3.5-flash-lite',
  fastResearch: process.env.COPILOT_RESEARCH_MODEL || 'gpt-5.6-luna',
  haiku: process.env.COPILOT_HAIKU_MODEL || 'claude-haiku-4-5-20251001',
  suggestion: process.env.COPILOT_SUGGEST_MODEL || process.env.COPILOT_SUGGESTION_MODEL || 'claude-sonnet-5',
  worker: process.env.COPILOT_WORKER_MODEL || 'claude-sonnet-5',
  // Pre-meeting prep agent (prep/agent.ts) — web research on the subscription CLI.
  prep: process.env.COPILOT_PREP_MODEL || 'claude-sonnet-5',
  review: process.env.COPILOT_REVIEW_MODEL || 'claude-opus-5',
} as const;

export type LlmTransportMode = 'api' | 'cli' | 'auto';

function transportMode(value: string | undefined): LlmTransportMode {
  return value === 'api' || value === 'cli' ? value : 'auto';
}

export const LLM_CONFIG = {
  liveTransport: transportMode(process.env.COPILOT_LIVE_LLM_MODE),
  workerTransport: transportMode(process.env.COPILOT_WORKER_LLM_MODE),
} as const;
