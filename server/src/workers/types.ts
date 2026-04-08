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
    type: 'text' | 'markdown' | 'image' | 'code';
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
  type: 'research' | 'fast-research' | 'summary' | 'mockup' | 'codegen' | 'analysis';
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
}
