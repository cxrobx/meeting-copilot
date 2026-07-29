export const MODEL_CONFIG = {
  triage: process.env.COPILOT_TRIAGE_MODEL || 'gpt-5.6-luna',
  agenda: process.env.COPILOT_AGENDA_MODEL || 'gpt-5.6-luna',
  agendaReconcile: process.env.COPILOT_AGENDA_RECONCILE_MODEL || 'gpt-5.6-terra',
  coach: process.env.COPILOT_COACH_MODEL || 'gpt-5.6-terra',
  geminiTriage: process.env.COPILOT_GEMINI_TRIAGE_MODEL || 'gemini-3.5-flash-lite',
  fastResearch: process.env.COPILOT_RESEARCH_MODEL || 'gpt-5.6-luna',
  haiku: process.env.COPILOT_HAIKU_MODEL || 'claude-haiku-4-5-20251001',
  suggestion: process.env.COPILOT_SUGGEST_MODEL || process.env.COPILOT_SUGGESTION_MODEL || 'claude-sonnet-5',
  worker: process.env.COPILOT_WORKER_MODEL || 'claude-sonnet-5',
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
