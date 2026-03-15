import { claudeSuggest } from '../claude-cli.js';
import type { Worker, WorkerCapabilities, WorkerResult } from './types.js';

const WIREFRAME_DELIMITER = '---WIREFRAME---';

export class MockupWorker implements Worker {
  public readonly name = 'mockup';
  public readonly capabilities: WorkerCapabilities = {
    network: 'anthropic-only',
    filesystem: {
      read: [],
      write: ['/tmp/meeting-copilot/**'],
    },
    subprocess: true,
    maxDurationMs: 180_000,
    maxMemoryMB: 200,
  };

  async execute(
    params: Record<string, any>,
    signal: AbortSignal,
  ): Promise<WorkerResult> {
    const description = params.description as string | undefined;
    const context = params.context as string | undefined;
    const platform = (params.platform as string) ?? 'web';
    const style = (params.style as string) ?? 'detailed';

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

    try {
      const systemPrompt = `You are a UI/UX designer creating wireframe specifications from meeting discussions. Your output has two parts separated by the exact delimiter "${WIREFRAME_DELIMITER}".

PART 1 (Markdown Specification):
- Component hierarchy and layout structure
- Interaction patterns (clicks, hovers, navigation)
- Data bindings and dynamic content areas
- Responsive behavior notes
- Key design decisions

${WIREFRAME_DELIMITER}

PART 2 (ASCII Wireframe):
Create a visual wireframe using box-drawing characters. Use:
  ┌─────────┐  for containers/cards
  │         │  for content areas
  └─────────┘
  ├─────────┤  for dividers
  ┃ ▓▓▓▓▓▓ ┃  for images/media placeholders
  [ Button ]   for buttons
  [________]   for input fields
  ○ Option     for radio buttons
  ☐ Option     for checkboxes
  ≡            for menu/hamburger

Platform: ${platform}
Style: ${style === 'minimal' ? 'Keep the wireframe simple — key layout elements only, no fine details.' : 'Include detailed layout with all UI elements, spacing indicators, and annotations.'}

Important: Output the markdown spec first, then "${WIREFRAME_DELIMITER}" on its own line, then the ASCII wireframe. Do not include any other delimiters or separators.`;

      const userContent = context
        ? `Design a UI mockup for: ${description}\n\nMeeting context:\n${context}`
        : `Design a UI mockup for: ${description}`;

      const text = await claudeSuggest(userContent, systemPrompt, signal);

      if (signal.aborted) {
        return {
          success: false,
          data: null,
          summary: 'Mockup cancelled during execution',
          error: 'Aborted',
        };
      }

      // Split on delimiter
      const parts = text.split(WIREFRAME_DELIMITER);
      const specSection = parts[0]!.trim();
      const wireframeSection = parts.length > 1 ? parts.slice(1).join(WIREFRAME_DELIMITER).trim() : null;

      const artifacts: WorkerResult['artifacts'] = [
        {
          type: 'markdown',
          content: specSection,
          title: `Mockup: ${description}`,
        },
      ];

      if (wireframeSection) {
        artifacts.push({
          type: 'code',
          content: wireframeSection,
          title: `Wireframe: ${description}`,
        });
      }

      return {
        success: true,
        data: { description, platform, style, spec: specSection, wireframe: wireframeSection },
        summary: `Mockup generated for: ${description}`,
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
