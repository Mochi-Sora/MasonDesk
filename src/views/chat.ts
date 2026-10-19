// The chat view: streaming text, reasoning blocks, tool/file-edit chips, approvals,
// interrupt. It renders from the store; the ChatController owns the transcript.

import { button, el, type ViewContext, type ViewModule } from "../app";
import { protocolErrorCode } from "../chat";
import { formatClock } from "../format";
import {
  createPending,
  filesFrom,
  formatBytes,
  formatDuration,
  previewFor,
  recordingSupported,
  startVoiceNote,
  uploadLimit,
  type PendingAttachment,
  type VoiceNoteRecorder,
} from "../media";
import type { AttachmentMeta } from "../protocol";
import type { ChatMessage, QueuedSummary } from "../store";

interface RenderedMessage {
  el: HTMLElement;
  roleEl: HTMLElement;
  timeEl: HTMLElement;
  reasoningEl: HTMLElement;
  attachmentsEl: HTMLElement;
  bodyEl: HTMLElement;
  toolsEl: HTMLElement;
  progressEl: HTMLElement;
  role: string;
  text: string;
  ts: number;
  streaming: boolean;
  reasoningEls: HTMLElement[];
  toolKeys: Map<string, string>;
  fileKeys: Map<string, string>;
  attachmentSignature: string;
  progress: string | null;
}

function roleLabel(role: string): string {
  if (role === "user") return "You";
  if (role === "system") return "System";
  return "Mason";
}

function toolKey(name: string, phase: string, ok: boolean | undefined, summary?: string): string {
  return `${name}|${phase}|${ok ?? ""}|${summary ?? ""}`;
}

function fileKey(chip: { phase: string; ok?: boolean }): string {
  return `${chip.phase}|${chip.ok ?? ""}`;
}

/** One attachment chip inside a message box: thumbnail/player plus name and size. */
function attachmentNode(attachment: AttachmentMeta): HTMLElement {
  const node = el("div", `attach ${attachment.kind}`);
  const preview = previewFor(attachment.attachment_id);
  if (attachment.kind === "image" && preview) {
    const image = el("img", "attach-thumb");
    image.src = preview;
    image.alt = attachment.name;
    image.loading = "lazy";
    image.onclick = () => window.open(preview, "_blank");
    node.append(image);
  } else if (attachment.kind === "video" && preview) {
    const video = el("video", "attach-video");
    video.src = preview;
    video.controls = true;
    video.preload = "metadata";
    node.append(video);
  } else if (attachment.kind === "audio" && preview) {
    const audio = el("audio", "attach-audio");
    audio.src = preview;
    audio.controls = true;
    audio.preload = "metadata";
    node.append(audio);
  } else {
    // Reloaded from history (or a kind without a preview): metadata only.
    node.classList.add("no-preview");
    node.append(el("span", "attach-kind", attachment.kind));
  }
  const meta = el("div", "attach-meta");
  meta.append(el("span", "attach-name", attachment.name));
  const detail = [formatBytes(attachment.size)];
  if (attachment.duration_ms) detail.unshift(formatDuration(attachment.duration_ms));
  meta.append(el("span", "attach-size", detail.join(" · ")));
  node.append(meta);
  return node;
}

export const chatView: ViewModule = {
  mount(root: HTMLElement, ctx: ViewContext): () => void {
    const view = el("div", "view chat-view");

    const head = el("header", "view-head");
    const titleWrap = el("div", "view-title");
    const heading = el("h2", undefined, "Chat");
    const subtitle = el("span", "subtle", "new session");
    titleWrap.append(heading, subtitle);
    const headActions = el("div", "view-actions");
    const newSessionBtn = button("New session", "btn ghost");
    const interruptBtn = button("Stop", "btn danger");
    interruptBtn.disabled = true;
    headActions.append(newSessionBtn, interruptBtn);
    head.append(titleWrap, headActions);

    const pairingBanner = el("div", "banner pairing hidden");
    const emptyState = el("div", "empty-state");
    const messagesEl = el("div", "messages");
    const approvalsEl = el("div", "approvals");

    const composer = el("form", "composer");
    const pendingStrip = el("div", "composer-attachments");
    const composerRow = el("div", "composer-row");
    const attachBtn = button("Attach", "btn ghost");
    const fileInput = el("input", "hidden-file");
    fileInput.type = "file";
    fileInput.multiple = true;
    const recordBtn = button("Record", "btn ghost");
    const input = el("textarea", "composer-input");
    input.rows = 2;
    const steerBtn = button("Steer", "btn ghost");
    steerBtn.classList.add("hidden");
    steerBtn.title = "Send into the running turn (⌘↵)";
    const queueBtn = button("Queue", "btn ghost");
    queueBtn.classList.add("hidden");
    queueBtn.title = "Send when the running turn ends (Enter)";
    const sendBtn = button("Send", "btn primary");
    sendBtn.type = "submit";
    composerRow.append(attachBtn, fileInput, recordBtn, input, steerBtn, queueBtn, sendBtn);
    composer.append(pendingStrip, composerRow);

    view.append(head, pairingBanner, emptyState, messagesEl, approvalsEl, composer);
    root.append(view);

    const rendered = new Map<string, RenderedMessage>();
    let renderedSession: string | null | undefined = undefined;

    // --- message nodes ------------------------------------------------------

    const createMessageNode = (message: ChatMessage): RenderedMessage => {
      const article = el("article", `msg msg-${message.role} streaming`);

      const msgHead = el("div", "msg-head");
      const roleEl = el("span", "msg-role", roleLabel(message.role));
      const timeEl = el("span", "msg-time", formatClock(message.ts));
      msgHead.append(roleEl, timeEl);

      const reasoningEl = el("div", "msg-reasoning");
      const attachmentsEl = el("div", "msg-attachments");
      const bodyEl = el("div", "msg-body");
      const toolsEl = el("div", "msg-tools");
      const progressEl = el("div", "msg-progress hidden");
      article.append(msgHead, reasoningEl, attachmentsEl, bodyEl, toolsEl, progressEl);

      const entry: RenderedMessage = {
        el: article,
        roleEl,
        timeEl,
        reasoningEl,
        attachmentsEl,
        bodyEl,
        toolsEl,
        progressEl,
        role: message.role,
        text: "",
        ts: message.ts,
        streaming: !message.streaming,
        reasoningEls: [],
        toolKeys: new Map(),
        fileKeys: new Map(),
        attachmentSignature: "",
        progress: null,
      };
      messagesEl.append(article);
      return entry;
    };

    const rebuildReasoning = (entry: RenderedMessage, message: ChatMessage): void => {
      entry.reasoningEl.replaceChildren();
      entry.reasoningEls = [];
      for (const block of message.reasoning) {
        const details = el("details", `reasoning${block.done ? " done" : ""}`);
        const summary = el("summary", undefined, block.done ? "Reasoning" : "Reasoning…");
        const pre = el("pre", undefined, block.text);
        details.append(summary, pre);
        entry.reasoningEl.append(details);
        entry.reasoningEls.push(details);
      }
    };

    const updateMessageNode = (entry: RenderedMessage, message: ChatMessage): void => {
      if (entry.role !== message.role) {
        entry.role = message.role;
        entry.el.className = `msg msg-${message.role}`;
        entry.roleEl.textContent = roleLabel(message.role);
      }
      if (entry.ts !== message.ts) {
        entry.ts = message.ts;
        entry.timeEl.textContent = formatClock(message.ts);
      }
      if (entry.text !== message.text) {
        entry.text = message.text;
        entry.bodyEl.textContent = message.text;
      }
      if (entry.streaming !== message.streaming) {
        entry.streaming = message.streaming;
        entry.el.classList.toggle("streaming", message.streaming);
      }

      // Reasoning blocks: rebuild on structural change, patch otherwise.
      if (entry.reasoningEls.length !== message.reasoning.length) {
        rebuildReasoning(entry, message);
      } else {
        for (let index = 0; index < message.reasoning.length; index += 1) {
          const block = message.reasoning[index];
          const details = entry.reasoningEls[index];
          const pre = details.querySelector("pre");
          if (pre && pre.textContent !== block.text) pre.textContent = block.text;
          const wantsDone = block.done;
          if (details.classList.contains("done") !== wantsDone) {
            details.classList.toggle("done", wantsDone);
            const summary = details.querySelector("summary");
            if (summary) summary.textContent = wantsDone ? "Reasoning" : "Reasoning…";
          }
        }
      }

      // Tool chips.
      for (const chip of message.tools) {
        const key = toolKey(chip.name, chip.phase, chip.ok, chip.summary);
        const existing = entry.toolKeys.get(chip.id);
        if (existing === key) continue;
        entry.toolKeys.set(chip.id, key);
        let chipEl = entry.toolsEl.querySelector<HTMLElement>(`[data-tool="${CSS.escape(chip.id)}"]`);
        if (!chipEl) {
          chipEl = el("span", "chip tool");
          chipEl.dataset.tool = chip.id;
          entry.toolsEl.append(chipEl);
        }
        chipEl.className = `chip tool ${chip.phase}${chip.ok === false ? " err" : ""}`;
        chipEl.textContent = chip.summary ? `${chip.name} · ${chip.summary}` : chip.name;
      }

      // File edit chips.
      for (const chip of message.fileEdits) {
        const key = fileKey(chip);
        const existing = entry.fileKeys.get(chip.path);
        if (existing === key) continue;
        entry.fileKeys.set(chip.path, key);
        let chipEl = entry.toolsEl.querySelector<HTMLElement>(`[data-file="${CSS.escape(chip.path)}"]`);
        if (!chipEl) {
          chipEl = el("span", "chip file");
          chipEl.dataset.file = chip.path;
          entry.toolsEl.append(chipEl);
        }
        chipEl.className = `chip file ${chip.phase}${chip.ok === false ? " err" : ""}`;
        chipEl.textContent = chip.path;
      }

      const progress = message.progress;
      if (entry.progress !== progress) {
        entry.progress = progress;
        entry.progressEl.classList.toggle("hidden", !progress);
        entry.progressEl.textContent = progress ?? "";
      }

      // Attachments (user turns that carried media). The preview marker makes a
      // strip rebuild once fetched bytes arrive after a reload.
      const attachmentSignature = message.attachments
        .map(
          (attachment) =>
            `${attachment.attachment_id}|${attachment.size}|${previewFor(attachment.attachment_id) ? "preview" : "chip"}`,
        )
        .join("\u0000");
      if (entry.attachmentSignature !== attachmentSignature) {
        entry.attachmentSignature = attachmentSignature;
        entry.attachmentsEl.replaceChildren();
        for (const attachment of message.attachments) {
          entry.attachmentsEl.append(attachmentNode(attachment));
        }
      }
    };

    const syncMessages = (messages: ChatMessage[]): void => {
      const seen = new Set<string>();
      for (const message of messages) {
        seen.add(message.messageId);
        let entry = rendered.get(message.messageId);
        if (!entry) {
          entry = createMessageNode(message);
          rendered.set(message.messageId, entry);
        }
        updateMessageNode(entry, message);
      }
      for (const [id, entry] of rendered) {
        if (!seen.has(id)) {
          entry.el.remove();
          rendered.delete(id);
        }
      }
    };

    // --- approvals ----------------------------------------------------------

    const syncApprovals = (): void => {
      const state = ctx.store.get();
      approvalsEl.replaceChildren();
      for (const approval of state.approvals) {
        const card = el("div", "approval");
        const text = el("div", "approval-text");
        text.append(el("strong", undefined, `${approval.tool} wants approval`));
        text.append(el("span", undefined, approval.summary));
        if (approval.argsPreview) {
          const pre = el("pre", "approval-args", approval.argsPreview);
          text.append(pre);
        }
        const buttons = el("div", "approval-actions");
        const approveBtn = button("Approve", "btn primary");
        const denyBtn = button("Deny", "btn ghost");
        approveBtn.onclick = () => {
          void ctx.actions.approve(approval.approvalId);
        };
        denyBtn.onclick = () => {
          void ctx.actions.deny(approval.approvalId);
        };
        buttons.append(approveBtn, denyBtn);
        card.append(text, buttons);
        approvalsEl.append(card);
      }
    };

    // --- banner / header / composer -----------------------------------------

    let sendMode: "send" | "stop" = "send";

    /** While a turn runs the primary button becomes Stop, so it is never hidden. */
    const setSendMode = (mode: "send" | "stop"): void => {
      if (mode === sendMode) return;
      sendMode = mode;
      if (mode === "stop") {
        sendBtn.textContent = "Stop";
        sendBtn.className = "btn danger";
        sendBtn.type = "button";
        sendBtn.onclick = () => void stopTurn();
      } else {
        sendBtn.textContent = "Send";
        sendBtn.className = "btn primary";
        sendBtn.type = "submit";
        sendBtn.onclick = null;
      }
    };

    const syncHeader = (): void => {
      const state = ctx.store.get();
      const session = state.sessions.find((candidate) => candidate.id === state.activeSessionId);
      subtitle.textContent = session
        ? session.title || session.id
        : state.activeSessionId ?? "new session";
      const connected = state.status.state === "connected";
      const canChat = connected && state.paired;
      const busy = state.chatBusy;
      const steering = state.features.includes("chat.inject");
      const canCompose = canChat && !busy && !sending && recorder === null;
      setSendMode(busy ? "stop" : "send");
      interruptBtn.disabled = !connected || !busy;
      // The draft box stays editable while a turn runs, like before.
      input.disabled = !canChat;
      sendBtn.disabled = busy ? !connected : !canCompose;
      attachBtn.disabled = !canCompose;
      recordBtn.disabled = !canCompose;
      attachBtn.classList.toggle("hidden", busy);
      recordBtn.classList.toggle("hidden", busy || !recordingSupported());
      steerBtn.classList.toggle("hidden", !busy || !steering);
      steerBtn.disabled = !canChat || !steering;
      queueBtn.classList.toggle("hidden", !busy);
      queueBtn.disabled = !canChat;
      input.placeholder = !connected
        ? "Not connected — pick a profile and connect."
        : !state.paired
          ? "Pair this device to start chatting."
          : busy
            ? steering
              ? "Mason is answering · Enter queues · ⌘↵ steers · Esc stops"
              : "Mason is answering · Enter queues · Esc stops"
            : "Message Mason… (Enter to send, Shift+Enter for a newline)";
    };

    const stopTurn = async (): Promise<void> => {
      try {
        await ctx.actions.interrupt();
      } catch (error) {
        if (protocolErrorCode(error) === "no_turn") {
          ctx.actions.toast("that turn already finished");
          syncHeader();
          return;
        }
        ctx.actions.toast(`interrupt failed: ${String(error)}`, "error");
      }
    };

    const syncPairingBanner = (): void => {
      const { pairing } = ctx.store.get();
      pairingBanner.replaceChildren();
      pairingBanner.classList.toggle("hidden", pairing === null);
      if (!pairing) return;
      const text = el("div", "banner-text");
      text.append(el("strong", undefined, "Pairing required"));
      const line = el("span");
      const command = el("code", undefined, `mason pairing approve ${pairing.code}`);
      line.append("On the gateway host, run ", command, " — this window updates automatically.");
      text.append(line);
      if (pairing.reason && pairing.reason !== "missing") {
        text.append(el("span", "subtle", `Reason: ${pairing.reason}`));
      }
      pairingBanner.append(text, el("span", "pairing-code", pairing.code));
    };

    const syncEmptyState = (): void => {
      const state = ctx.store.get();
      const empty = state.messages.length === 0;
      emptyState.classList.toggle("hidden", !empty);
      if (!empty) return;
      emptyState.replaceChildren();
      if (state.status.state !== "connected") {
        emptyState.append(
          el("p", undefined, "Not connected. Choose a profile in the top bar and press Connect."),
        );
      } else if (!state.paired) {
        emptyState.append(el("p", undefined, "Waiting for device approval — see the pairing banner."));
      } else {
        emptyState.append(
          el("p", undefined, "Connected. Say hello — the first message starts a new session."),
        );
      }
    };

    // --- composer: attachments, voice notes, drag & drop ----------------------

    let pending: PendingAttachment[] = [];
    let sending = false;
    let recorder: VoiceNoteRecorder | null = null;
    let recordStartedAt = 0;
    let recordTick: ReturnType<typeof setInterval> | null = null;
    const failures = new Map<string, string>();

    const queuedNode = (item: QueuedSummary): HTMLElement => {
      const chip = el("div", "attach-pending queued");
      chip.append(el("span", "attach-kind", "queued"));
      const meta = el("div", "attach-meta");
      meta.append(el("span", "attach-name", item.text));
      meta.append(el("span", "attach-size", "sends when this turn ends"));
      chip.append(meta);
      const remove = button("✕", "btn ghost small");
      remove.title = "Remove from the queue";
      remove.onclick = () => {
        ctx.actions.unqueue(item.id);
        syncHeader();
      };
      chip.append(remove);
      return chip;
    };

    const pendingNode = (attachment: PendingAttachment): HTMLElement => {
      const failure = failures.get(attachment.id);
      const chip = el("div", `attach-pending ${attachment.kind}${failure ? " err" : ""}`);
      if (attachment.previewUrl && attachment.kind === "image") {
        const thumb = el("img", "attach-thumb small");
        thumb.src = attachment.previewUrl;
        thumb.alt = attachment.name;
        chip.append(thumb);
      } else {
        chip.append(el("span", "attach-kind", attachment.kind));
      }
      const meta = el("div", "attach-meta");
      meta.append(el("span", "attach-name", attachment.name));
      const detail = [formatBytes(attachment.size)];
      if (attachment.durationMs) detail.unshift(formatDuration(attachment.durationMs));
      if (attachment.remote) detail.push("uploaded");
      meta.append(el("span", "attach-size", failure ?? detail.join(" · ")));
      chip.append(meta);
      const remove = button("✕", "btn ghost small");
      remove.title = "Remove attachment";
      remove.onclick = () => {
        pending = pending.filter((candidate) => candidate.id !== attachment.id);
        failures.delete(attachment.id);
        renderPending();
        syncHeader();
      };
      chip.append(remove);
      return chip;
    };

    const renderPending = (): void => {
      pendingStrip.replaceChildren();
      const state = ctx.store.get();
      const queued = state.queued.filter((item) => item.sessionId === state.activeSessionId);
      const visible = pending.length > 0 || recorder !== null || queued.length > 0;
      pendingStrip.classList.toggle("hidden", !visible);
      pendingStrip.classList.toggle("busy", sending);
      for (const item of queued) pendingStrip.append(queuedNode(item));
      if (recorder) {
        const chip = el("div", "attach-pending recording");
        chip.append(el("span", "attach-kind", "rec"));
        const meta = el("div", "attach-meta");
        meta.append(el("span", "attach-name", "Recording…"));
        meta.append(
          el("span", "attach-size", formatDuration(Date.now() - recordStartedAt)),
        );
        chip.append(meta);
        const actions = el("div", "attach-actions");
        const stop = button("Use note", "btn ghost small");
        stop.onclick = () => {
          void finishRecording();
        };
        const cancel = button("✕", "btn ghost small");
        cancel.title = "Discard the recording";
        cancel.onclick = () => cancelRecording();
        actions.append(stop, cancel);
        chip.append(actions);
        pendingStrip.append(chip);
      }
      for (const attachment of pending) pendingStrip.append(pendingNode(attachment));
    };

    const addFiles = (list: FileList | null | undefined): void => {
      const files = filesFrom(list);
      if (files.length === 0) return;
      const limit = uploadLimit();
      let oversized = 0;
      for (const file of files) {
        if (file.size > limit) {
          oversized += 1;
          continue;
        }
        pending.push(createPending(file));
      }
      if (oversized > 0) {
        ctx.actions.toast(
          `${oversized} file(s) are larger than ${formatBytes(limit)}`,
          "error",
        );
      }
      renderPending();
      syncHeader();
    };

    const startRecording = async (): Promise<void> => {
      if (!recordingSupported()) {
        ctx.actions.toast("voice notes are not available in this webview", "error");
        return;
      }
      try {
        recorder = await startVoiceNote();
      } catch (error) {
        recorder = null;
        ctx.actions.toast(`microphone unavailable: ${String(error)}`, "error");
        return;
      }
      recordStartedAt = Date.now();
      recordBtn.textContent = "Stop";
      renderPending();
      syncHeader();
      recordTick = setInterval(() => {
        const chip = pendingStrip.querySelector(".attach-pending.recording .attach-size");
        if (chip) chip.textContent = formatDuration(Date.now() - recordStartedAt);
      }, 250);
    };

    const finishRecording = async (): Promise<void> => {
      const active = recorder;
      if (!active) return;
      recorder = null;
      if (recordTick !== null) {
        clearInterval(recordTick);
        recordTick = null;
      }
      recordBtn.textContent = "Record";
      try {
        const note = await active.finish();
        if (note) pending.push(note);
        else ctx.actions.toast("nothing was recorded", "error");
      } catch (error) {
        ctx.actions.toast(`recording failed: ${String(error)}`, "error");
      }
      renderPending();
      syncHeader();
    };

    const cancelRecording = (): void => {
      const active = recorder;
      if (!active) return;
      recorder = null;
      if (recordTick !== null) {
        clearInterval(recordTick);
        recordTick = null;
      }
      recordBtn.textContent = "Record";
      active.cancel();
      renderPending();
      syncHeader();
    };

    // --- render loop ---------------------------------------------------------

    let queuedSignature = "";
    const syncQueueStrip = (): void => {
      const signature = ctx.store
        .get()
        .queued.map((item) => `${item.id}:${item.sessionId}`)
        .join("|");
      if (signature === queuedSignature) return;
      queuedSignature = signature;
      renderPending();
    };

    let nearBottom = true;
    const render = (): void => {
      const state = ctx.store.get();
      if (renderedSession !== state.activeSessionId) {
        messagesEl.replaceChildren();
        rendered.clear();
        renderedSession = state.activeSessionId;
      }
      const distance = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
      nearBottom = distance < 80;
      syncMessages(state.messages);
      syncApprovals();
      syncHeader();
      syncQueueStrip();
      syncPairingBanner();
      syncEmptyState();
      if (nearBottom) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    };

    const unsubscribe = ctx.store.subscribe(render);
    render();

    // --- interactions ---------------------------------------------------------

    const submit = async (): Promise<void> => {
      if (recorder !== null) {
        ctx.actions.toast("finish or discard the voice note first");
        return;
      }
      const text = input.value;
      if (!text.trim() && pending.length === 0) return;
      if (sending) {
        // An upload or the previous send is still in flight; Enter used to be a
        // silent no-op here, which read as "my message vanished".
        ctx.actions.toast("still sending the previous message…");
        return;
      }
      if (ctx.store.get().chatBusy) {
        // One turn per session: deliver this when the running one ends.
        if (pending.length > 0) {
          ctx.actions.toast("Mason is answering — attachments can't be queued; wait for the turn");
          return;
        }
        if (ctx.actions.queueMessage(text)) {
          input.value = "";
          input.focus();
        }
        return;
      }
      const batch = pending;
      sending = true;
      failures.clear();
      renderPending();
      syncHeader();
      input.value = "";
      try {
        await ctx.actions.sendChat(text, batch);
        pending = [];
      } catch (error) {
        input.value = text;
        input.focus();
        for (const attachment of batch) {
          if (!attachment.remote) failures.set(attachment.id, "not uploaded");
        }
        const code = protocolErrorCode(error);
        if (code === "busy") {
          ctx.actions.toast(
            "this session already has a turn running (started elsewhere) — try again when it finishes",
            "error",
          );
        } else {
          ctx.actions.toast(`send failed: ${String(error)}`, "error");
        }
      } finally {
        sending = false;
        renderPending();
        syncHeader();
      }
    };

    const steerNow = async (): Promise<void> => {
      const text = input.value;
      if (!text.trim()) return;
      input.value = "";
      try {
        // Success is visible in place: the message appears in the transcript
        // (steered) or as a queued chip (queued). No success toast.
        await ctx.actions.steer(text);
      } catch (error) {
        input.value = text;
        input.focus();
        ctx.actions.toast(`steer failed: ${String(error)}`, "error");
      }
    };

    composer.addEventListener("submit", (event) => {
      event.preventDefault();
      void submit();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      const state = ctx.store.get();
      if (state.chatBusy && state.features.includes("chat.inject") && (event.metaKey || event.ctrlKey)) {
        void steerNow();
        return;
      }
      void submit();
    });
    steerBtn.onclick = () => {
      void steerNow();
    };
    queueBtn.onclick = () => {
      const text = input.value;
      if (!text.trim()) return;
      if (ctx.actions.queueMessage(text)) {
        input.value = "";
        input.focus();
      }
    };
    attachBtn.onclick = () => fileInput.click();
    fileInput.onchange = () => {
      addFiles(fileInput.files);
      fileInput.value = "";
    };
    recordBtn.onclick = () => {
      if (recorder === null) void startRecording();
      else void finishRecording();
    };
    input.addEventListener("paste", (event) => {
      const files = event.clipboardData?.files;
      if (files && files.length > 0) {
        event.preventDefault();
        addFiles(files);
      }
    });

    let dragDepth = 0;
    view.addEventListener("dragenter", (event) => {
      event.preventDefault();
      dragDepth += 1;
      view.classList.add("dropping");
    });
    view.addEventListener("dragover", (event) => {
      event.preventDefault();
    });
    view.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) view.classList.remove("dropping");
    });
    view.addEventListener("drop", (event) => {
      event.preventDefault();
      dragDepth = 0;
      view.classList.remove("dropping");
      if (event.dataTransfer && event.dataTransfer.files.length > 0) {
        addFiles(event.dataTransfer.files);
      }
    });
    newSessionBtn.onclick = () => {
      ctx.actions.newSession();
      input.focus();
    };
    interruptBtn.onclick = () => {
      void stopTurn();
    };
    view.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && ctx.store.get().chatBusy) {
        event.preventDefault();
        void stopTurn();
      }
    });

    return () => {
      unsubscribe();
      if (recordTick !== null) clearInterval(recordTick);
      recorder?.cancel();
    };
  },
};
