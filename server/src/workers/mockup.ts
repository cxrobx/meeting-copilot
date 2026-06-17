import { claudeSuggest } from '../claude-cli.js';
import type { Worker, WorkerCapabilities, WorkerResult } from './types.js';

// Fixed wireframe width. The prompt asks the model to pad every line to this
// many columns; normalizeWireframe() then enforces it so the box borders line
// up in a perfect column even when the model drifts a few characters.
const WIREFRAME_WIDTH = 58;

const ASCII_SYSTEM = `You are a UI wireframe generator. Given a UI description, output a SINGLE ASCII wireframe using box-drawing characters.

Palette:
  ┌─┐ │ └─┘ ├─┤   box borders and dividers
  [ Button ]      buttons
  [____________]  text inputs
  ☐ Option        checkboxes      ○ Option   radio buttons
  ≡               menu / hamburger ▓▓▓        image / media placeholder

STRICT FORMATTING RULES:
- The wireframe is EXACTLY ${WIREFRAME_WIDTH} columns wide. Every single line must be exactly ${WIREFRAME_WIDTH} characters — pad short lines with trailing spaces BEFORE the right border so every right-hand │ lines up in one straight column.
- Use one outer box; keep all inner content inside it and vertically aligned.
- Keep it tight: key layout regions and the most important controls only.
- Output ONLY the wireframe. No title, no prose, no explanation, no markdown code fences.`;

const HTML_SYSTEM = `You are a UI mockup generator. Given a UI description, output ONE self-contained HTML document that visually mocks up the described interface.

RULES:
- A complete <!DOCTYPE html> document with ALL CSS inline in a single <style> block. No external stylesheets, web fonts, scripts, or remote images.
- Use neutral system fonts only: font-family: system-ui, -apple-system, "Segoe UI", sans-serif.
- Square edges only — set border-radius: 0 everywhere.
- Clean and realistic: light background, clear visual hierarchy, sensible spacing, and plausible placeholder copy drawn from the description. Use CSS blocks/gradients for any image placeholders.
- No JavaScript whatsoever — a static mockup only.
- Output ONLY the HTML document. No prose, no explanation, no markdown code fences.`;

/**
 * Right-pad every line to the max visual width so the wireframe renders as a
 * clean rectangle and the right-hand box borders line up. For bordered rows
 * (start and end with a vertical box char), the padding is inserted BEFORE the
 * trailing border so the right edge aligns rather than trailing off the box.
 */
export function normalizeWireframe(raw: string): string {
  const lines = stripFences(raw)
    .replace(/\t/g, '  ')
    .split('\n')
    .map((l) => l.replace(/\s+$/g, '')); // strip trailing whitespace first

  // Drop leading/trailing blank lines.
  while (lines.length && lines[0]!.trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();

  // Box-drawing chars are single-column in a monospace cell, so code-point
  // count is the visual width.
  const width = (s: string): number => Array.from(s).length;
  const maxW = lines.reduce((m, l) => Math.max(m, width(l)), 0);

  return lines
    .map((l) => {
      const w = width(l);
      if (w >= maxW) return l;
      const pad = ' '.repeat(maxW - w);
      // Bordered row → insert padding before the trailing vertical border.
      if (/^[│|┃]/.test(l) && /[│|┃]$/.test(l)) {
        return l.slice(0, -1) + pad + l.slice(-1);
      }
      return l + pad;
    })
    .join('\n');
}

/** Strip a leading/trailing markdown code fence (```lang ... ```), if present. */
function stripFences(text: string): string {
  let t = text.trim();
  const fence = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fence) return fence[1]!.trim();
  return t;
}

export class MockupWorker implements Worker {
  public readonly name = 'mockup';
  public readonly capabilities: WorkerCapabilities = {
    network: 'anthropic-only',
    filesystem: {
      read: [],
      write: ['/tmp/meeting-copilot/**'],
    },
    subprocess: true,
    // Generous safety cap (~15 min): jobs run until done or the user cancels.
    // A truly-hung CLI still fails via its own timeout → the card shows Retry.
    maxDurationMs: 900_000,
    maxMemoryMB: 200,
  };

  async execute(
    params: Record<string, any>,
    signal: AbortSignal,
  ): Promise<WorkerResult> {
    const description = params.description as string | undefined;
    const context = params.context as string | undefined;
    const platform = (params.platform as string) ?? 'web';
    // Revision mode: when a base mockup is supplied, `description` is the change
    // set ("make the header sticky"), not a from-scratch UI description.
    const baseWireframe = (params.baseWireframe as string | undefined)?.trim() || undefined;
    const baseHtml = (params.baseHtml as string | undefined)?.trim() || undefined;
    const isRevision = Boolean(baseWireframe || baseHtml);
    const emitEarly = params._emitEarly as ((partial: WorkerResult) => void) | undefined;

    if (!description) {
      return {
        success: false,
        data: null,
        summary: 'No description provided for mockup',
        error: 'Missing required param: description',
      };
    }

    if (signal.aborted) {
      return {
        success: false,
        data: null,
        summary: 'Mockup cancelled before start',
        error: 'Aborted',
      };
    }

    const contextSuffix = context ? `\n\nMeeting context:\n${context}` : '';

    try {
      // ── Phase A: fast ASCII wireframe (shown immediately) ──
      // In revision mode with a base wireframe, hand the model the original and
      // ask for the full updated version; otherwise design from scratch.
      const asciiPrompt =
        isRevision && baseWireframe
          ? `Here is an existing ASCII wireframe:\n\n${baseWireframe}\n\nRevise it to apply these changes: ${description}\nReturn the COMPLETE updated wireframe, keeping the same ${WIREFRAME_WIDTH}-column box format.\nPlatform: ${platform}${contextSuffix}`
          : `Design an ASCII wireframe for: ${description}\nPlatform: ${platform}${contextSuffix}`;
      const asciiRaw = await claudeSuggest(asciiPrompt, ASCII_SYSTEM, signal);

      if (signal.aborted) {
        return {
          success: false,
          data: null,
          summary: 'Mockup cancelled during wireframe',
          error: 'Aborted',
        };
      }

      const wireframe = normalizeWireframe(asciiRaw);
      const asciiArtifact = {
        type: 'code' as const,
        content: wireframe,
        title: `${isRevision ? 'Wireframe (revised)' : 'Wireframe'}: ${description}`,
      };

      // Surface the wireframe right away while the HTML phase runs.
      emitEarly?.({
        success: true,
        data: { description, platform, wireframe },
        summary: `${isRevision ? 'Revised wireframe' : 'Wireframe'} ready for: ${description} — rendering HTML…`,
        artifacts: [asciiArtifact],
      });

      // ── Phase B: styled, self-contained HTML mockup ──
      let html: string | null = null;
      let htmlError: string | null = null;
      try {
        // Revise the supplied HTML when present; else build from the (possibly
        // just-revised) description. Either way the model returns a full doc.
        const htmlPrompt = baseHtml
          ? `Here is an existing HTML mockup:\n\n${baseHtml}\n\nRevise it to apply these changes: ${description}\nReturn the COMPLETE updated, self-contained HTML document.\nPlatform: ${platform}${contextSuffix}`
          : `Build an HTML mockup for: ${description}\nPlatform: ${platform}${contextSuffix}`;
        const htmlRaw = await claudeSuggest(htmlPrompt, HTML_SYSTEM, signal);
        if (signal.aborted) {
          return {
            success: false,
            data: null,
            summary: 'Mockup cancelled during HTML render',
            error: 'Aborted',
          };
        }
        html = stripFences(htmlRaw);
      } catch (err) {
        if (signal.aborted) {
          return {
            success: false,
            data: null,
            summary: 'Mockup cancelled during HTML render',
            error: 'Aborted',
          };
        }
        // HTML phase failed but the ASCII already rendered — degrade
        // gracefully and keep the wireframe rather than failing the card.
        htmlError = err instanceof Error ? err.message : String(err);
      }

      const artifacts: WorkerResult['artifacts'] = [asciiArtifact];
      if (html) {
        artifacts.push({
          type: 'html',
          content: html,
          title: `${isRevision ? 'HTML Mockup (revised)' : 'HTML Mockup'}: ${description}`,
        });
      }

      const verb = isRevision ? 'revised' : 'generated';
      return {
        success: true,
        data: { description, platform, wireframe, html },
        summary: html
          ? `Mockup ${verb} for: ${description}`
          : `Wireframe ${verb} for: ${description} (HTML render failed: ${htmlError})`,
        artifacts,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        data: null,
        summary: `Mockup generation failed: ${message}`,
        error: message,
      };
    }
  }
}
