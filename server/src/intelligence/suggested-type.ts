/**
 * Which worker an AI-suggested card runs on.
 *
 * Suggested research cards run Fast (Luna + web search) by default, not the
 * Sonnet research worker. Measured 2026-09-21 on `npm run eval:research`:
 * equal accuracy (19/19 each) at a 3.9s median vs 8.3s, worst case 8s vs 38s,
 * for ~1-2 cents a searched answer. A card that lands after the topic has
 * moved on is worth nothing, so speed wins here. Deep research (Opus 5.5)
 * still runs alongside and appends what it adds (workers/deep-follow-up.ts),
 * as it does for the dashboard's Research button and the menu bar's Ask.
 *
 * `COPILOT_SUGGESTED_RESEARCH=deep` puts suggested cards on Deep alone.
 */
export function routeSuggestedType<T extends string>(
  type: T,
  env: NodeJS.ProcessEnv = process.env,
): T | 'fast-research' | 'research' {
  if (type !== 'research') return type;
  return env.COPILOT_SUGGESTED_RESEARCH === 'deep' ? 'research' : 'fast-research';
}
