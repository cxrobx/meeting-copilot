// "Say next" coach prompts, v1.
// One cheap JSON call per window: is there ONE high-priority thing the user
// should mention, ask, or address right now? Silence is the default.

export type CoachKind = 'mention' | 'ask' | 'address';

export interface CoachSuggestionResult {
  hasSuggestion: boolean;
  kind: CoachKind;
  priority: number; // 1-5
  headline: string;
  phrasing: string;
  why: string;
  triggerQuote: string;
}

export const COACH_SYSTEM = `You are a silent meeting coach for the user ("You" in the transcript). Watch the conversation and surface AT MOST ONE high-priority thing the user should say next.

Kinds:
- "mention": a fact, constraint, agenda item, or risk the user knows about that the conversation needs and nobody has raised.
- "ask": a question the user should ask — an unstated assumption, a missing commitment (owner/date), an ambiguity that will bite later.
- "address": something said that the user should respond to before the moment passes — a concern aimed at them, a misunderstanding of their position, a decision drifting against their stated goals.

Rules:
- Suggest ONLY when it genuinely matters (priority 4-5). The right output for most windows is hasSuggestion=false. You are not a chat partner; you are a tap on the shoulder.
- When the user's private goals are provided, suggestions that advance or protect those goals OUTRANK generic meeting hygiene. A goal slipping away — a deferred decision, a drifting commitment, an unanswered ask — is exactly the moment to speak.
- Never suggest something already said or already on a suggestion you made before (the prompt lists recent ones).
- "phrasing" is one natural sentence the user could say out loud, in plain spoken English.
- "why" is one short clause explaining the stakes.

Respond with JSON only.`;

export function buildCoachPrompt(params: {
  transcriptWindow: string;
  agendaSummary: string;
  meetingTitle: string;
  attendees: string;
  recentSuggestions: string[];
  userGoals?: string;
  speakerBalance?: string;
  momentHint?: string;
}): string {
  const parts: string[] = [];
  if (params.meetingTitle) parts.push(`Meeting: ${params.meetingTitle}`);
  if (params.attendees) parts.push(`Attendees: ${params.attendees}`);
  if (params.userGoals) parts.push(`The user's PRIVATE GOALS for this meeting (weigh suggestions against these):\n${params.userGoals}`);
  if (params.agendaSummary) parts.push(`Agenda state:\n${params.agendaSummary}`);
  if (params.speakerBalance) parts.push(`Speaking balance: ${params.speakerBalance}`);
  if (params.momentHint) parts.push(`Why you are being consulted right now: ${params.momentHint}`);
  if (params.recentSuggestions.length > 0) {
    parts.push(`Recent suggestions already shown (do not repeat):\n${params.recentSuggestions.map((s) => `- ${s}`).join('\n')}`);
  }
  parts.push(`Latest transcript window ("You" = the user's mic):\n\n${params.transcriptWindow}`);
  return parts.join('\n\n');
}

export const COACH_SCHEMA = {
  name: 'coach_suggestion',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['hasSuggestion', 'kind', 'priority', 'headline', 'phrasing', 'why', 'triggerQuote'],
    properties: {
      hasSuggestion: { type: 'boolean' },
      kind: { type: 'string', enum: ['mention', 'ask', 'address'] },
      priority: { type: 'number', description: '1-5; only 4-5 are worth interrupting for' },
      headline: { type: 'string', description: 'Few-word label, e.g. "Pin down the owner"' },
      phrasing: { type: 'string', description: 'One sentence the user could say out loud' },
      why: { type: 'string', description: 'One short clause on the stakes' },
      triggerQuote: { type: 'string', description: 'Short verbatim quote that prompted this' },
    },
  },
} as const;
