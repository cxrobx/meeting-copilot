export interface WorkerCapabilities {
  network: 'none' | 'anthropic-only' | 'web-search' | 'unrestricted';
  filesystem: { read: string[]; write: string[] };
  subprocess: boolean;
  maxDurationMs: number;
  maxMemoryMB: number;
}

export interface WorkerResult {
  success: boolean;
  data: any;
  summary: string;
  artifacts?: Array<{
    type: 'text' | 'markdown' | 'image' | 'code' | 'html';
    content: string;
    title?: string;
  }>;
  error?: string;
}

export interface Worker {
  name: string;
  capabilities: WorkerCapabilities;
  execute(
    params: Record<string, any>,
    signal: AbortSignal,
  ): Promise<WorkerResult>;
}

export interface ActionSuggestion {
  type: 'research' | 'fast-research' | 'summary' | 'mockup' | 'codegen' | 'analysis' | 'review';
  title: string;
  description: string;
  triggerQuote: string;
  estimatedDurationSec: number;
  params: Record<string, any>;
}

export interface ActionLifecycle {
  id: string;
  type: string;
  title: string;
  description: string;
  triggerQuote: string;
  estimatedDurationSec: number;
  params: Record<string, any>;
  state:
    | 'suggested'
    | 'approved'
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'expired';
  createdAt: number;
  approvedAt?: number;
  startedAt?: number;
  completedAt?: number;
  timeoutMs: number;
  retryCount: number;
  result?: WorkerResult;
  cancelController: AbortController;
  /** True while the suggestion JSON is still streaming in (card is forming). */
  streaming?: boolean;
  /** True once `params` has fully parsed — safe to dispatch the worker. */
  paramsReady?: boolean;
  /** User approved while still streaming + params not ready; dispatch on ready. */
  pendingApproval?: boolean;
  /**
   * Session-critical action fired by the server itself (auto-summary,
   * auto-review, rolling summary). System actions bypass the concurrency cap
   * and survive onMeetingEnd's expire/cancel sweep — they are exactly the
   * work the user expects to exist after the meeting ends.
   */
  system?: boolean;
}
