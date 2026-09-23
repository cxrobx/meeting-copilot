// Realtime recovery-coach prompt. The output is intentionally tiny: one
// intervention the user can say immediately, or silence.

export type CoachKind = 'mention' | 'ask' | 'address';
export type CoachIncidentType =
  | 'none'
  | 'pressure'
  | 'objection'
  | 'bad_answer'
  | 'overcommitment'
  | 'confusion'
  | 'contradiction'
  | 'agenda_risk'
  | 'decision'
  | 'commitment'
  | 'question';

export interface CoachSuggestionResult {
  hasSuggestion: boolean;
  kind: CoachKind;
  incidentType: CoachIncidentType;
  priority: number; // 1-5
  confidence: number; // 0-1
  headline: string;
  phrasing: string;
  why: string;
  triggerQuote: string;
  expiresInMs: number;
}

const COACH_JSON_CONTRACT = `JSON fields:
{"hasSuggestion":boolean,"kind":"mention"|"ask"|"address","incidentType":"none"|"pressure"|"objection"|"bad_answer"|"overcommitment"|"confusion"|"contradiction"|"agenda_risk"|"decision"|"commitment"|"question","priority":1-5,"confidence":0-1,"headline":string,"phrasing":string,"why":string,"triggerQuote":string,"expiresInMs":integer}
When hasSuggestion=false, use empty strings for text fields, incidentType="none", and conservative numeric values.`;

export const COACH_SYSTEM = `Role: You are a discreet, real-time meeting recovery coach for the user ("You" in the transcript).

Goal: Decide whether the user needs one high-value sentence to say immediately. Catch client pressure, objections, confusion, weak or evasive answers, unsupported commitments, contradictions, and agenda items about to slip.

Success criteria:
- Intervene only for priority 5 moments where silence would materially harm the user's position or leave a serious mistake unrecovered.
- Priority 4 means "useful in a post-meeting review", not "interrupt now"; return hasSuggestion=false for priority 4 or below.
- "phrasing" is one natural spoken sentence, normally under 28 words.
- For a weak answer, provide a graceful reset or clarification. Never shame, scold, or label the user as stupid.
- For pressure or an objection, help the user acknowledge the concern without conceding an unsupported fact, price, scope, or deadline.
- Private goals and active agenda risks outrank generic meeting etiquette.

Stop rules:
- Silence is correct for ordinary conversation, harmless filler, style preferences, or when the user has already recovered.
- Silence is correct for ordinary informational questions, optional follow-ups, topic transitions, agenda facilitation, and advice that merely makes an already-adequate answer more polished.
- A pending agenda item is not itself a risk. Intervene only when an explicit missing warning says it is about to slip.
- Do not repeat something already said or a recent suggestion.
- Do not invent facts, dates, authority, or commitments.
- Return exactly the structured JSON contract. No prose or chain-of-thought.

${COACH_JSON_CONTRACT}`;

/**
 * "Suggest": the user pressed the button, so silence is the wrong answer. Same
 * JSON contract as COACH_SYSTEM; only the bar for speaking up changes.
 */
export const COACH_ASK_SYSTEM = `Role: You are a discreet meeting coach for the user ("You" in the transcript). The user just pressed "Suggest": they want the single most useful thing to say, ask, or raise next.

Rules:
- Return hasSuggestion=true with your best move. Return false only when the transcript gives you nothing to act on.
- Pick what helps the user most right now: answer a question still hanging, recover a weak answer, move toward their private goals, raise an agenda item about to slip, ask the question that would move things forward, or pin down an owner and a date.
- If the user gave a focus, answer that focus.
- "phrasing" is one natural spoken sentence, normally under 28 words, ready to say aloud. "headline" is 3 to 6 words. "why" is one short clause.
- kind is "ask" for a question to put to them, "mention" for something to raise, "address" for a response to what was just said.
- Never shame or scold the user. Do not repeat a recent suggestion unless it is still the best move and still unaddressed.
- Do not invent facts, dates, authority, or commitments.
- Return exactly the structured JSON contract. No prose or chain-of-thought.

${COACH_JSON_CONTRACT}`;

export function buildCoachPrompt(params: {
  transcriptWindow: string;
  agendaSummary: string;
  meetingTitle: string;
  attendees: string;
  recentSuggestions: string[];
  userGoals?: string;
  speakerBalance?: string;
  momentHint?: string;
  triggerSource?: 'mic' | 'meeting' | 'system';
  triggerText?: string;
}): string {
  const parts: string[] = [];
  if (params.meetingTitle) parts.push(`Meeting: ${params.meetingTitle}`);
  if (params.attendees) parts.push(`Attendees: ${params.attendees}`);
  if (params.userGoals) parts.push(`The user's PRIVATE GOALS for this meeting (weigh suggestions against these):\n${params.userGoals}`);
  if (params.agendaSummary) parts.push(`Agenda state:\n${params.agendaSummary}`);
  if (params.speakerBalance) parts.push(`Speaking balance: ${params.speakerBalance}`);
  if (params.momentHint) parts.push(`Why you are being consulted right now: ${params.momentHint}`);
  if (params.triggerText) {
    parts.push(`Immediate trigger (${params.triggerSource ?? 'system'}):\n${params.triggerText}`);
  }
  if (params.recentSuggestions.length > 0) {
    parts.push(`Recent suggestions already shown (do not repeat):\n${params.recentSuggestions.map((s) => `- ${s}`).join('\n')}`);
  }
  parts.push(`Latest ordered turns ("You" = the user's mic):\n<transcript>\n${params.transcriptWindow}\n</transcript>`);
  return parts.join('\n\n');
}

export const COACH_SCHEMA = {
  name: 'coach_suggestion',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'hasSuggestion',
      'kind',
      'incidentType',
      'priority',
      'confidence',
      'headline',
      'phrasing',
      'why',
      'triggerQuote',
      'expiresInMs',
    ],
    properties: {
      hasSuggestion: { type: 'boolean' },
      kind: { type: 'string', enum: ['mention', 'ask', 'address'] },
      incidentType: {
        type: 'string',
        enum: [
          'none',
          'pressure',
          'objection',
          'bad_answer',
          'overcommitment',
          'confusion',
          'contradiction',
          'agenda_risk',
          'decision',
          'commitment',
          'question',
        ],
      },
      priority: { type: 'number', description: '1-5; only 4-5 are worth interrupting for' },
      confidence: { type: 'number', description: '0-1 confidence that intervening is helpful now' },
      headline: { type: 'string', description: 'Few-word label, e.g. "Pin down the owner"' },
      phrasing: { type: 'string', description: 'One sentence the user could say out loud' },
      why: { type: 'string', description: 'One short, non-judgmental clause on the stakes' },
      triggerQuote: { type: 'string', description: 'Short verbatim quote that prompted this' },
      expiresInMs: {
        type: 'integer',
        description: 'How long this advice remains useful, usually 8000-30000 milliseconds',
      },
    },
  },
} as const;
