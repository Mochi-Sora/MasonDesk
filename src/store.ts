// A tiny observable store with requestAnimationFrame batching — enough for a
// five-screen app, no framework required.

import type { PairingState, StatusPayload } from "./connection/client";
import type { ProfilesState } from "./connection/profiles";
import type { AttachmentMeta, CronJob, MemoryStats, SessionMeta } from "./protocol";

export interface ToolChip {
  id: string;
  name: string;
  phase: string;
  summary?: string;
  ok?: boolean;
}

export interface FileEditChip {
  path: string;
  phase: string;
  ok?: boolean;
  diffPreview?: string;
}

export interface ReasoningBlock {
  text: string;
  done: boolean;
}

export interface ChatMessage {
  messageId: string;
  sessionId: string;
  turnId: string | null;
  role: string;
  text: string;
  ts: number;
  reasoning: ReasoningBlock[];
  tools: ToolChip[];
  fileEdits: FileEditChip[];
  attachments: AttachmentMeta[];
  progress: string | null;
  streaming: boolean;
}

export interface ApprovalCard {
  approvalId: string;
  sessionId: string;
  turnId: string;
  tool: string;
  summary: string;
  argsPreview?: string;
}

export interface QueuedSummary {
  id: string;
  sessionId: string;
  text: string;
}

export interface AppState {
  profiles: ProfilesState;
  status: StatusPayload;
  paired: boolean;
  pairing: PairingState | null;
  features: string[];
  sessions: SessionMeta[];
  activeSessionId: string | null;
  chatBusy: boolean;
  messages: ChatMessage[];
  queued: QueuedSummary[];
  approvals: ApprovalCard[];
  cron: CronJob[];
  memory: MemoryStats | null;
  lastError: string | null;
  devMode: boolean;
}

export interface Store {
  get(): AppState;
  set(patch: Partial<AppState>): void;
  subscribe(handler: (state: AppState) => void): () => void;
}

export function createStore(initial: AppState): Store {
  let state = initial;
  const handlers = new Set<(state: AppState) => void>();
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    for (const handler of handlers) handler(state);
  };

  return {
    get: () => state,
    set(patch: Partial<AppState>) {
      state = { ...state, ...patch };
      if (scheduled) return;
      scheduled = true;
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(flush);
      } else {
        setTimeout(flush, 0);
      }
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
