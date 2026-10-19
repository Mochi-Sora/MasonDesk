// Turns protocol chat events into the renderable transcript in the store.
//
// Tools / file edits / progress frames are turn-scoped (they carry no message_id — see
// docs/protocol.md). They are attached to the last assistant message of their turn; if
// none exists yet they wait in a per-turn buffer and are drained into the next one.
//
// One assistant turn renders as exactly one box. The server may split a long answer into
// several stream segments (output-token recovery) and reopen the stream with a fresh
// message id; while the turn's box is still streaming, a segment that arrives under a new
// id is folded into it instead of starting a second box.

import type { Client } from "./connection/client";
import {
  fetchAttachmentBytes,
  fetchEnabled,
  registerPreview,
  releasePreviews,
  uploadAttachment,
  type PendingAttachment,
} from "./media";
import {
  asNumber,
  asString,
  makeId,
  payload,
  type AttachmentMeta,
  type ChatSendResult,
  type DeltaEvent,
  type EventFrame,
  type FileEditPayload,
  type HistoryMessage,
  type MessageEvent,
  type ProgressPayload,
  type ReasoningEndEvent,
  type SessionsHistoryResult,
  type ToolEventPayload,
  type TurnEndPayload,
} from "./protocol";
import type { ChatMessage, FileEditChip, Store, ToolChip } from "./store";

interface TurnBuffer {
  tools: ToolChip[];
  fileEdits: FileEditChip[];
  progress: string | null;
}

interface QueuedMessage {
  id: string;
  sessionId: string;
  text: string;
}

/** What steering a running turn produced; the view uses it for feedback. */
export type SteerOutcome = "steered" | "queued" | "sent";

/**
 * Internal prompts the framework injected between model calls after a truncated
 * answer (mason/utils/runtime.py) in transcripts written before `886e91d3`.
 * Current gateways hide those entries and mark the following segment with
 * `continued: true` instead, so this list only rescues older sessions.
 */
const LEGACY_INTERNAL_PROMPTS = [
  "The previous assistant response was cut off.",
  "Please provide your response to the user based on the conversation above.",
  "The tool-call budget for this turn is exhausted.",
];

function isLegacyInternalPrompt(role: string, text: string): boolean {
  return role === "user" && LEGACY_INTERNAL_PROMPTS.some((prompt) => text.startsWith(prompt));
}

/** The protocol error code of a rejected request, if it carries one. */
export function protocolErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export class ChatController {
  private messages: ChatMessage[] = [];
  private readonly buffers = new Map<string, TurnBuffer>();
  private readonly activeTurns = new Map<string, string>();
  /** The assistant box currently open per turn: `${sessionId}\u0000${turnId}` → id. */
  private readonly openBoxes = new Map<string, string>();
  /** Messages typed while a turn runs, delivered when it ends (FIFO per session). */
  private readonly queue: QueuedMessage[] = [];
  /** Queued ids with a delivery attempt in flight, so a turn.end cannot double-send. */
  private readonly delivering = new Set<string>();

  constructor(
    private readonly client: Client,
    private readonly store: Store,
    private readonly notify: (message: string, kind?: "info" | "error") => void = () => {},
  ) {}

  busy(sessionId: string | null): boolean {
    return sessionId !== null && this.activeTurns.has(sessionId);
  }

  reset(sessionId: string | null): void {
    this.messages = [];
    this.buffers.clear();
    this.activeTurns.clear();
    this.openBoxes.clear();
    releasePreviews();
    this.store.set({ activeSessionId: sessionId, messages: [], chatBusy: false });
  }

  async openSession(sessionId: string | null): Promise<void> {
    if (sessionId === null) {
      this.reset(null);
      return;
    }
    const result = await this.client.request<SessionsHistoryResult>("sessions.history", {
      session_id: sessionId,
    });
    this.messages = this.foldHistory(result.messages, sessionId);
    this.buffers.clear();
    this.activeTurns.clear();
    this.openBoxes.clear();
    this.store.set({
      activeSessionId: sessionId,
      messages: [...this.messages],
      chatBusy: false,
    });
    void this.hydrateAttachments(sessionId, this.messages);
  }

  /**
   * A replayed transcript carries attachment metadata but no bytes. When the
   * gateway supports `media.fetch`, pull the displayable ones and re-render;
   * anything unavailable simply stays a chip.
   */
  private async hydrateAttachments(sessionId: string, messages: ChatMessage[]): Promise<void> {
    if (!fetchEnabled()) return;
    let landed = false;
    for (const message of messages) {
      for (const attachment of message.attachments) {
        const url = await fetchAttachmentBytes(this.client, sessionId, attachment);
        if (url) landed = true;
      }
    }
    if (landed && this.store.get().activeSessionId === sessionId) this.publish();
  }

  async send(text: string, attachments: PendingAttachment[] = []): Promise<void> {
    await this.sendTo(this.store.get().activeSessionId, text, attachments);
  }

  /**
   * Send text into the turn that is already running, if the gateway supports it.
   * Falls back to queueing (or a normal send when the turn just ended) so the
   * same keystroke is never lost.
   */
  async steer(text: string): Promise<SteerOutcome> {
    const trimmed = text.trim();
    if (!trimmed) return "sent";
    const sessionId = this.store.get().activeSessionId;
    if (sessionId === null || !this.busy(sessionId)) {
      await this.send(trimmed);
      return "sent";
    }
    if (!this.steeringEnabled()) {
      this.queueMessage(trimmed);
      return "queued";
    }
    try {
      await this.client.request("chat.inject", { session_id: sessionId, text: trimmed });
      return "steered";
    } catch (error) {
      const code = protocolErrorCode(error);
      if (code === "unsupported") {
        this.queueMessage(trimmed);
        return "queued";
      }
      if (code === "no_turn") {
        // The turn finished between the keystroke and the request.
        await this.send(trimmed);
        return "sent";
      }
      throw error;
    }
  }

  /** Queue text for the active session; returns whether it was accepted. */
  queueMessage(text: string): boolean {
    const trimmed = text.trim();
    const sessionId = this.store.get().activeSessionId;
    if (!trimmed || sessionId === null) return false;
    this.queue.push({ id: makeId(), sessionId, text: trimmed });
    this.publish();
    return true;
  }

  unqueue(id: string): void {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.publish();
  }

  private steeringEnabled(): boolean {
    return this.store.get().features.includes("chat.inject");
  }

  private async sendTo(
    sessionId: string | null,
    text: string,
    attachments: PendingAttachment[] = [],
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    const params: Record<string, unknown> = { session_id: sessionId, text: trimmed };
    const uploaded: AttachmentMeta[] = [];
    for (const attachment of attachments) {
      const meta = await uploadAttachment(this.client, attachment);
      registerPreview(meta.attachment_id, attachment);
      uploaded.push(meta);
    }
    if (uploaded.length > 0) {
      params.attachments = uploaded.map((meta) => meta.attachment_id);
    }
    // A `busy` rejection means the session already has a turn — started from
    // another connection, or by one this client lost (a page reload mid-answer).
    // It is not ours to interrupt, so the view explains it rather than guessing.
    const result = await this.client.request<ChatSendResult>("chat.send", params);
    this.activeTurns.set(result.session_id, result.turn_id);
    if (sessionId !== result.session_id) {
      this.store.set({ activeSessionId: result.session_id });
    }
    this.publish();
  }

  async interrupt(): Promise<void> {
    const sessionId = this.store.get().activeSessionId;
    if (sessionId === null) return;
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) return;
    try {
      await this.client.request("turn.interrupt", { session_id: sessionId, turn_id: turnId });
    } catch (error) {
      if (protocolErrorCode(error) === "no_turn") {
        // The turn already finished (or another connection owns it now): drop
        // the stale bookkeeping so the composer is usable again.
        this.activeTurns.delete(sessionId);
        this.publish();
      }
      throw error;
    }
  }

  handle(frame: EventFrame): void {
    switch (frame.type) {
      case "message":
        this.applyMessage(payload<MessageEvent>(frame.event));
        break;
      case "delta":
        this.applyDelta(payload<DeltaEvent>(frame.event));
        break;
      case "reasoning_delta":
        this.applyReasoningDelta(payload<DeltaEvent>(frame.event));
        break;
      case "reasoning_end":
        this.applyReasoningEnd(payload<ReasoningEndEvent>(frame.event));
        break;
      case "tool":
        this.applyTool(payload<ToolEventPayload>(frame.event));
        break;
      case "file_edit":
        this.applyFileEdit(payload<FileEditPayload>(frame.event));
        break;
      case "progress":
        this.applyProgress(payload<ProgressPayload>(frame.event));
        break;
      case "turn.end":
        this.applyTurnEnd(payload<TurnEndPayload>(frame.event));
        break;
      default:
        break; // Unknown event types must be ignored (forward compatibility).
    }
  }

  // --- event appliers -------------------------------------------------------

  private applyMessage(event: MessageEvent): void {
    const sessionId = asString(event.session_id);
    if (!this.isActive(sessionId)) return;
    const role = asString(event.role, "assistant");
    const turnId = asString(event.turn_id);
    const rawId = asString(event.message_id, makeId());
    const messageId = this.resolveBox(rawId, sessionId, turnId, role === "assistant");
    const message = this.findOrCreate(messageId, sessionId, turnId);
    if (event.replaced === true) {
      // The server discarded this segment and regenerates the answer into the
      // same box: drop the rendered text but keep the box open so the next
      // segment folds into it instead of starting a second one.
      message.text = "";
      message.streaming = true;
      for (const block of message.reasoning) block.done = true;
      this.publish();
      return;
    }
    const continuation = messageId !== rawId;
    message.role = role;
    message.text = asString(event.text);
    message.ts = asNumber(event.ts, Date.now());
    // A `message` frame is authoritative for its id; when it lands on a box that
    // is still streaming it is the next segment of the same answer, so the box
    // stays open and the cursor keeps blinking until turn.end.
    message.streaming = continuation ? message.streaming : false;
    if (!continuation) message.attachments = attachmentList(event.attachments);
    for (const block of message.reasoning) block.done = true;
    this.drainBuffer(message);
    this.publish();
  }

  private applyDelta(event: DeltaEvent): void {
    const sessionId = asString(event.session_id);
    if (!this.isActive(sessionId)) return;
    const turnId = asString(event.turn_id);
    const messageId = this.resolveBox(
      asString(event.message_id, makeId()),
      sessionId,
      turnId,
      true,
    );
    const message = this.findOrCreate(messageId, sessionId, turnId);
    message.text += asString(event.text_delta);
    message.streaming = true;
    this.drainBuffer(message);
    this.publish();
  }

  private applyReasoningDelta(event: DeltaEvent): void {
    const sessionId = asString(event.session_id);
    if (!this.isActive(sessionId)) return;
    const turnId = asString(event.turn_id);
    const messageId = this.resolveBox(
      asString(event.message_id, makeId()),
      sessionId,
      turnId,
      true,
    );
    const message = this.findOrCreate(messageId, sessionId, turnId);
    const delta = asString(event.text_delta);
    const last = message.reasoning[message.reasoning.length - 1];
    if (!last || last.done) {
      message.reasoning.push({ text: delta, done: false });
    } else {
      last.text += delta;
    }
    message.streaming = true;
    this.publish();
  }

  private applyReasoningEnd(event: ReasoningEndEvent): void {
    const sessionId = asString(event.session_id);
    if (!this.isActive(sessionId)) return;
    const turnId = asString(event.turn_id);
    const messageId = this.resolveBox(
      asString(event.message_id, makeId()),
      sessionId,
      turnId,
      true,
    );
    const message = this.findOrCreate(messageId, sessionId, turnId);
    const last = message.reasoning[message.reasoning.length - 1];
    if (last) last.done = true;
    this.publish();
  }

  private applyTool(event: ToolEventPayload): void {
    const sessionId = asString(event.session_id);
    if (!this.isActive(sessionId)) return;
    const turnId = asString(event.turn_id);
    const owner = this.lastMessageForTurn(sessionId, turnId);
    const id = asString(event.tool_call_id, makeId());
    const patch: Partial<ToolChip> = {
      name: asString(event.name, "tool"),
      phase: asString(event.phase, "start"),
      summary: asString(event.summary) || undefined,
      ok: typeof event.ok === "boolean" ? event.ok : undefined,
    };
    const list = owner ? owner.tools : this.bufferFor(turnId).tools;
    const existing = list.find((chip) => chip.id === id);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      list.push({ id, name: patch.name as string, phase: patch.phase as string, ...patch });
    }
    this.publish();
  }

  private applyFileEdit(event: FileEditPayload): void {
    const sessionId = asString(event.session_id);
    if (!this.isActive(sessionId)) return;
    const turnId = asString(event.turn_id);
    const owner = this.lastMessageForTurn(sessionId, turnId);
    const path = asString(event.path, "unknown");
    const patch: Partial<FileEditChip> = {
      path,
      phase: asString(event.phase, "start"),
      ok: typeof event.ok === "boolean" ? event.ok : undefined,
      diffPreview: asString(event.diff_preview) || undefined,
    };
    const list = owner ? owner.fileEdits : this.bufferFor(turnId).fileEdits;
    const existing = list.find((chip) => chip.path === path);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      list.push({ path, phase: patch.phase as string, ...patch });
    }
    this.publish();
  }

  private applyProgress(event: ProgressPayload): void {
    const sessionId = asString(event.session_id);
    if (!this.isActive(sessionId)) return;
    const turnId = asString(event.turn_id);
    const text = asString(event.text);
    const owner = this.lastMessageForTurn(sessionId, turnId);
    if (owner) owner.progress = text;
    else this.bufferFor(turnId).progress = text;
    this.publish();
  }

  private applyTurnEnd(event: TurnEndPayload): void {
    const sessionId = asString(event.session_id);
    const turnId = asString(event.turn_id);
    if (this.activeTurns.get(sessionId) === turnId) this.activeTurns.delete(sessionId);
    if (turnId) this.openBoxes.delete(`${sessionId}\u0000${turnId}`);
    // Deliver whatever was queued for this session while it was answering.
    this.flushQueue(sessionId);
    if (!this.isActive(sessionId)) return;
    for (const message of this.messages) {
      if (message.turnId === turnId) {
        message.streaming = false;
      }
    }
    this.flushBuffer(sessionId, turnId);
    this.publish();
  }

  // --- helpers ---------------------------------------------------------------

  private isActive(sessionId: string): boolean {
    return this.store.get().activeSessionId === sessionId;
  }

  /**
   * The box an incoming assistant frame belongs to. The first segment of a turn
   * opens the box; while that box is still streaming, later segments that arrive
   * under a new message id are folded into it so one answer stays one box.
   */
  private resolveBox(
    rawId: string,
    sessionId: string,
    turnId: string,
    assistant: boolean,
  ): string {
    if (!assistant || !turnId) return rawId;
    const key = `${sessionId}\u0000${turnId}`;
    const open = this.openBoxes.get(key);
    if (open === undefined || open === rawId) {
      this.openBoxes.set(key, rawId);
      return rawId;
    }
    const existing = this.messages.find((candidate) => candidate.messageId === open);
    if (existing && existing.streaming) return open;
    this.openBoxes.set(key, rawId);
    return rawId;
  }

  private findOrCreate(messageId: string, sessionId: string, turnId: string): ChatMessage {
    let message = this.messages.find((candidate) => candidate.messageId === messageId);
    if (!message) {
      message = {
        messageId,
        sessionId,
        turnId: turnId || null,
        role: "assistant",
        text: "",
        ts: Date.now(),
        reasoning: [],
        tools: [],
        fileEdits: [],
        attachments: [],
        progress: null,
        streaming: false,
      };
      this.messages.push(message);
    }
    if (turnId && !message.turnId) message.turnId = turnId;
    return message;
  }

  private lastMessageForTurn(sessionId: string, turnId: string): ChatMessage | null {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message.sessionId === sessionId && message.turnId === turnId) return message;
    }
    return null;
  }

  private bufferFor(turnId: string): TurnBuffer {
    let buffer = this.buffers.get(turnId);
    if (!buffer) {
      buffer = { tools: [], fileEdits: [], progress: null };
      this.buffers.set(turnId, buffer);
    }
    return buffer;
  }

  private drainBuffer(message: ChatMessage): void {
    if (!message.turnId) return;
    const buffer = this.buffers.get(message.turnId);
    if (!buffer) return;
    message.tools.push(...buffer.tools);
    message.fileEdits.push(...buffer.fileEdits);
    if (buffer.progress) message.progress = buffer.progress;
    this.buffers.delete(message.turnId);
  }

  /** A turn that ended without any assistant message still shows its activity. */
  private flushBuffer(sessionId: string, turnId: string): void {
    const buffer = this.buffers.get(turnId);
    if (!buffer) return;
    const empty = buffer.tools.length === 0 && buffer.fileEdits.length === 0 && !buffer.progress;
    if (empty) {
      this.buffers.delete(turnId);
      return;
    }
    this.messages.push({
      messageId: `turn-${turnId}`,
      sessionId,
      turnId,
      role: "assistant",
      text: "",
      ts: Date.now(),
      reasoning: [],
      tools: buffer.tools,
      fileEdits: buffer.fileEdits,
      attachments: [],
      progress: buffer.progress,
      streaming: false,
    });
    this.buffers.delete(turnId);
  }

  /** History replay: one box per answer, following the server's `continued` marker. */
  private foldHistory(messages: HistoryMessage[], sessionId: string): ChatMessage[] {
    const folded: ChatMessage[] = [];
    let continuation = false;
    for (const message of messages) {
      const role = asString(message.role, "assistant");
      const text = asString(message.text);
      if (isLegacyInternalPrompt(role, text)) {
        // Pre-`886e91d3` transcripts: the recovery prompt is a visible entry and
        // the segment that follows it continues the previous answer.
        continuation = true;
        continue;
      }
      const continues = continuation || message.continued === true;
      if (continues && role === "assistant") {
        const previous = folded[folded.length - 1];
        if (previous && previous.role === "assistant") {
          // The runner's answer is the plain concatenation of its segments.
          previous.text += text;
          previous.reasoning.push(...historyReasoning(message));
          previous.tools.push(...historyTools(message));
          previous.fileEdits.push(...historyFileEdits(message));
          previous.attachments.push(...historyAttachments(message));
          continuation = false;
          continue;
        }
      }
      continuation = false;
      folded.push(this.fromHistory(message, sessionId));
    }
    return folded;
  }

  private fromHistory(message: HistoryMessage, sessionId: string): ChatMessage {
    return {
      messageId: asString(message.message_id, makeId()),
      sessionId,
      turnId: null,
      role: asString(message.role, "assistant"),
      text: asString(message.text),
      ts: asNumber(message.ts, Date.now()),
      reasoning: historyReasoning(message),
      tools: historyTools(message),
      fileEdits: historyFileEdits(message),
      attachments: historyAttachments(message),
      progress: null,
      streaming: false,
    };
  }

  private publish(): void {
    const activeSessionId = this.store.get().activeSessionId;
    this.store.set({
      messages: [...this.messages],
      chatBusy: activeSessionId !== null && this.activeTurns.has(activeSessionId),
      queued: this.queue.map(({ id, sessionId, text }) => ({ id, sessionId, text })),
    });
  }

  /** Deliver the next queued message for a session, once its turn is over. */
  private flushQueue(sessionId: string): void {
    const item = this.queue.find(
      (candidate) => candidate.sessionId === sessionId && !this.delivering.has(candidate.id),
    );
    if (!item) return;
    this.delivering.add(item.id);
    void this.deliverQueued(item, 0);
  }

  private async deliverQueued(item: QueuedMessage, attempt: number): Promise<void> {
    try {
      await this.sendTo(item.sessionId, item.text);
      this.delivering.delete(item.id);
      const index = this.queue.findIndex((candidate) => candidate.id === item.id);
      if (index >= 0) this.queue.splice(index, 1);
      this.publish();
    } catch (error) {
      // The gateway releases a session slightly after its turn.end frame, so a
      // queued message can race the idle transition. Retry briefly; the item
      // stays visible in the queue the whole time.
      if (protocolErrorCode(error) === "busy" && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        await this.deliverQueued(item, attempt + 1);
        return;
      }
      this.delivering.delete(item.id);
      this.publish();
      this.notify(`queued message could not be sent: ${String(error)}`, "error");
    }
  }
}

function historyReasoning(message: HistoryMessage): { text: string; done: boolean }[] {
  return (message.reasoning ?? []).map((block) => ({
    text: asString((block as { text?: unknown }).text),
    done: true,
  }));
}

function historyTools(message: HistoryMessage): ToolChip[] {
  return (message.tools ?? []).map((tool) => ({
    id: makeId(),
    name: asString((tool as { name?: unknown }).name, "tool"),
    phase: "end",
    summary: asString((tool as { summary?: unknown }).summary) || undefined,
    ok: typeof (tool as { ok?: unknown }).ok === "boolean" ? (tool as { ok: boolean }).ok : undefined,
  }));
}

function historyFileEdits(message: HistoryMessage): FileEditChip[] {
  return (message.file_edits ?? []).map((edit) => ({
    path: asString((edit as { path?: unknown }).path, "unknown"),
    phase: "end",
    ok: typeof (edit as { ok?: unknown }).ok === "boolean" ? (edit as { ok: boolean }).ok : undefined,
  }));
}

function historyAttachments(message: HistoryMessage): AttachmentMeta[] {
  return attachmentList(message.attachments);
}

function attachmentList(value: unknown): AttachmentMeta[] {
  if (!Array.isArray(value)) return [];
  const attachments: AttachmentMeta[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = asString(record.attachment_id);
    if (!id) continue;
    const kind = asString(record.kind, "file");
    const duration = asNumber(record.duration_ms, 0);
    attachments.push({
      attachment_id: id,
      name: asString(record.name, "attachment"),
      mime: asString(record.mime, "application/octet-stream"),
      kind: kind === "image" || kind === "audio" || kind === "video" ? kind : "file",
      size: asNumber(record.size),
      ...(duration > 0 ? { duration_ms: duration } : {}),
    });
  }
  return attachments;
}
