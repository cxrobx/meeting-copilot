/**
 * Paid-API kill switch.
 *
 * When `COPILOT_DISABLE_PAID_API` is set to a truthy value, the two paid-API
 * gates (`isOpenAiApiAvailable` / `isAnthropicApiAvailable`) report `false`
 * even when the keys are present. Every paid LLM call site checks one of those
 * gates first, so flipping them off forces ALL inference onto the headless
 * CLIs (the subscription) — guaranteeing zero OpenAI/Anthropic spend without
 * having to remove the keys from `~/.meeting-copilot/.env`.
 *
 * It ALSO covers the other metered API in the stack: `createProvider()` in
 * `transcription/index.ts` checks this flag and skips cloud STT (Grok by
 * default, or Deepgram), so no metered transcription (per-chunk or the startup
 * prewarm) can occur either. Net: a truthy flag = zero metered OpenAI /
 * Anthropic / xAI / Deepgram spend, regardless of which features you exercise.
 *
 * Use it for cost-safe testing: `COPILOT_DISABLE_PAID_API=1 ./scripts/start.sh`.
 * Proof it worked: `grep '\[api/' ~/.meeting-copilot/server.log` is empty, and
 * `grep "skipping" ~/.meeting-copilot/server.log` shows cloud STT was skipped too.
 */
export function paidApiDisabled(): boolean {
  const v = (process.env.COPILOT_DISABLE_PAID_API ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
