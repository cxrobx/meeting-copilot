/**
 * Which worker an AI-suggested card runs on.
 *
 * Suggested research cards run Fast (Luna + web search) by default, not the
 * Sonnet research worker. Measured 2026-09-21 on `npm run eval:research`:
 * equal accuracy (19/19 each) at a 3.9s median vs 8.3s, worst case 8s vs 38s,
 * for ~1-2 cents a searched answer. A card that lands after the topic has
 * moved on is worth nothing, so speed wins here. The manual Research button
 * is not routed through this and stays Sonnet, for when depth is the point.
 *
 * `COPILOT_SUGGESTED_RESEARCH=deep` puts suggested cards back on Sonnet.
 */
export function routeSuggestedType<T extends string>(
  type: T,
  env: NodeJS.ProcessEnv = process.env,
): T | 'fast-research' | 'research' {
  if (type !== 'research') return type;
  return env.COPILOT_SUGGESTED_RESEARCH === 'deep' ? 'research' : 'fast-research';
}
