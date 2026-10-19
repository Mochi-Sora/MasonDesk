// Protocol v1 — mirrors docs/protocol.md. This module is the single place where frame
// shapes live; both transports and every view go through it.

export const PROTOCOL_VERSION = 1;

export const APP_VERSION = "0.1.0";

export type RequestType =
  | "hello"
  | "chat.send"
  | "chat.inject"
  | "media.upload"
  | "media.fetch"
  | "turn.interrupt"
  | "sessions.list"
  | "sessions.history"
  | "memory.stats"
  | "cron.list"
  | "approve"
  | "deny"
  | "ping";

export type EventType =
  | "pairing.approved"
  | "pairing.denied"
  | "message"
  | "delta"
  | "reasoning_delta"
  | "reasoning_end"
  | "tool"
  | "file_edit"
  | "progress"
  | "approval"
  | "turn.end"
  | "session.updated";

export interface RequestFrame {
  v: number;
  id: string;
  type: RequestType;
  [key: string]: unknown;
}

export interface ProtocolError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ResponseFrame {
  v: number;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: ProtocolError;
}

export interface EventFrame {
  v: number;
  type: string;
  event: Record<string, unknown>;
}

export function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeRequest(
  type: RequestType,
  params: Record<string, unknown> = {},
): RequestFrame {
  return { v: PROTOCOL_VERSION, id: makeId(), type, ...params };
}

export function isResponse(value: unknown): value is ResponseFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as ResponseFrame;
  return typeof frame.id === "string" && typeof frame.ok === "boolean";
}

export function isEvent(value: unknown): value is EventFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as EventFrame;
  return typeof frame.type === "string" && typeof frame.event === "object" && frame.event !== null;
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Cast an event payload to its typed shape; every reader validates the fields it uses. */
export function payload<T>(event: Record<string, unknown>): T {
  return event as unknown as T;
}

// --- hello ------------------------------------------------------------------

export interface PairingInfo {
  code: string;
  expires_at: number;
}

export interface GatewayInfo {
  version?: string;
  started_at?: number | string | null;
}

/** Advertised server limits (v1.2+ addition; absent on older gateways). */
export interface GatewayLimits {
  /** Largest accepted `media.upload` payload, decoded. */
  max_upload_bytes?: number;
  /**
   * Present only when the gateway understands `media.fetch` (v1.3); its
   * absence is the client's feature detection — fall back to metadata-only
   * rendering.
   */
  max_fetch_bytes?: number;
}

export interface HelloResult {
  protocol: number;
  paired: boolean;
  device_token?: string | null;
  pairing?: PairingInfo | null;
  gateway?: GatewayInfo | null;
  reason?: string | null;
  limits?: GatewayLimits | null;
  /** Additive request frames the gateway understands (v1.4), e.g. "chat.inject". */
  features?: string[];
}

// --- sessions / cron / memory -------------------------------------------------

export interface SessionMeta {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  source?: string;
}

export interface HistoryTool {
  name: string;
  ok?: boolean;
  summary?: string;
}

export interface HistoryFileEdit {
  path: string;
  ok?: boolean;
}

export interface HistoryMessage {
  message_id: string;
  role: string;
  text: string;
  ts: number;
  reasoning?: { text: string }[];
  tools?: HistoryTool[];
  file_edits?: HistoryFileEdit[];
  /** This assistant entry continues the previous answer (recovery segment). */
  continued?: boolean;
  attachments?: AttachmentMeta[];
}

export interface SessionsListResult {
  sessions: SessionMeta[];
  next_cursor?: string | null;
}

export interface SessionsHistoryResult {
  session_id: string;
  messages: HistoryMessage[];
  next_cursor?: string | null;
}

export interface MemoryStats {
  enabled: boolean;
  episodes: number;
  memories: number;
  edges: number;
  pending_episodes: number;
  memory_uses_total: number;
  memories_never_used: number;
  consolidation_cursor: number;
  consolidation_last_attempt_at: number | string | null;
  consolidation_last_ok_at: number | string | null;
  consolidation_last_error: string | null;
  db_bytes: number;
  wal_bytes: number;
  last_checkpoint: number | string | null;
  last_snapshot: number | string | null;
}

export interface CronJob {
  id: string;
  name?: string;
  schedule: string;
  enabled: boolean;
  next_run_at?: number | null;
  last_run_at?: number | null;
  last_status?: string | null;
  payload_preview?: string;
}

export interface CronListResult {
  jobs: CronJob[];
}

// --- chat events ---------------------------------------------------------------

export interface MessageEvent {
  session_id: string;
  turn_id: string;
  message_id: string;
  role: string;
  text: string;
  ts: number;
  /** Present on the user-turn echo when the send carried attachments (§3.1). */
  attachments?: AttachmentMeta[];
  /**
   * The server discarded the text streamed for this `message_id` and will
   * regenerate the answer into the same box (`text` is empty). Clients drop
   * what they rendered for the id and keep rendering into it.
   */
  replaced?: boolean;
}

export interface DeltaEvent {
  session_id: string;
  turn_id: string;
  message_id: string;
  text_delta: string;
}

export interface ReasoningEndEvent {
  session_id: string;
  turn_id: string;
  message_id: string;
}

export interface ToolEventPayload {
  session_id: string;
  turn_id: string;
  tool_call_id: string;
  name: string;
  phase: string;
  summary?: string;
  args_preview?: string;
  ok?: boolean;
}

export interface FileEditPayload {
  session_id: string;
  turn_id: string;
  path: string;
  phase: string;
  ok?: boolean;
  diff_preview?: string;
}

export interface ProgressPayload {
  session_id: string;
  turn_id?: string;
  kind?: string;
  text: string;
}

export interface ApprovalPayload {
  session_id: string;
  turn_id: string;
  approval_id: string;
  tool: string;
  summary: string;
  args_preview?: string;
  deadline?: number;
}

export interface TurnEndPayload {
  session_id: string;
  turn_id: string;
  status: string;
  error?: string;
}

export interface SessionUpdatedPayload {
  session_id: string;
  title?: string;
  updated_at: number;
  message_count?: number;
}

export interface ChatSendResult {
  session_id: string;
  turn_id: string;
}

/** An attachment as the server reports it: upload result and user-echo metadata. */
export interface AttachmentMeta {
  attachment_id: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  /** Voice notes and clips report their length; absent when unknown. */
  duration_ms?: number;
}

/** `media.fetch` result: the stored bytes of one attachment, base64. */
export interface MediaFetchResult {
  attachment_id: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  duration_ms?: number;
  data: string;
}

export type AttachmentKind = "image" | "audio" | "video" | "file";

export interface PingResult {
  ts: number;
  server_time: number;
}
