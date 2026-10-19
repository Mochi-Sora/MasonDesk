#!/usr/bin/env node
// dev/smoke.mjs — conformance smoke test for docs/protocol.md against dev/mock-gateway.mjs.
//
//   npm run smoke
//
// Starts a few short-lived mock gateways on ephemeral ports and drives them with Node's built-in
// WebSocket client — including one with a tiny --max-upload-mb for the too_large path.
// Exits non-zero when any check fails.

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), "mock-gateway.mjs");

let checks = 0;
const failures = [];

function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`ok ${checks} — ${label}`);
  } else {
    failures.push(label);
    console.error(`FAIL ${checks} — ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function collectTurn(client, timeoutMs = 8000) {
  const frames = [];
  for (;;) {
    const frame = await client.nextAnyEvent(timeoutMs);
    frames.push(frame);
    if (frame.type === "turn.end") return frames;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startGateway(args) {
  const child = spawn(process.execPath, [MOCK, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => process.stderr.write(`[mock] ${chunk}`));
  return child;
}

let idCounter = 0;

class TestClient {
  constructor(url) {
    this.url = url;
    this.pending = new Map();
    this.queue = [];
    this.waiters = [];
  }

  async open() {
    const deadline = Date.now() + 8000;
    for (;;) {
      try {
        this.ws = await new Promise((resolve, reject) => {
          const socket = new WebSocket(this.url);
          socket.onopen = () => resolve(socket);
          socket.onerror = () => reject(new Error(`cannot reach ${this.url}`));
        });
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await sleep(120);
      }
    }
    this.ws.onmessage = (message) => this.dispatch(JSON.parse(message.data));
    this.ws.onclose = () => {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("connection closed"));
      }
    };
    return this;
  }

  dispatch(frame) {
    if (typeof frame.id === "string" && typeof frame.ok === "boolean") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.ok) {
        pending.resolve(frame.result ?? {});
      } else {
        pending.reject(
          Object.assign(new Error(frame.error?.message ?? "request failed"), {
            code: frame.error?.code,
            details: frame.error?.details,
          }),
        );
      }
      return;
    }
    if (typeof frame.type === "string") {
      const index = this.waiters.findIndex(
        (waiter) => waiter.type === null || waiter.type === frame.type,
      );
      if (index >= 0) {
        const waiter = this.waiters.splice(index, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
        return;
      }
      this.queue.push(frame);
    }
  }

  request(type, params = {}, timeoutMs = 8000) {
    const id = `c-${(idCounter += 1)}`;
    const frame = { v: 1, id, type, ...params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(frame));
    });
  }

  nextEvent(type, timeoutMs = 8000) {
    const index = this.queue.findIndex((frame) => frame.type === type);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    return this.#nextMatching(type, timeoutMs);
  }

  nextAnyEvent(timeoutMs = 8000) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    return this.#nextMatching(null, timeoutMs);
  }

  #nextMatching(type, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${type ?? "any event"} timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
      this.waiters.push({ type, resolve, reject, timer });
    });
  }

  async expectError(type, params = {}) {
    try {
      await this.request(type, params);
      return null;
    } catch (error) {
      return error;
    }
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

// --- gateway A: auto-approve flow, streaming, sessions, cron, memory, approvals -----

const portA = await freePort();
const gatewayA = startGateway(["--port", String(portA), "--quiet"]);
let clientA;
let clientB;
let clientB2;
let clientC;
let clientC2;
let clientD;
let clientF;
let gatewayB;
let gatewayC;
let gatewayD;
let gatewayF;

try {
  clientA = await new TestClient(`ws://127.0.0.1:${portA}`).open();

  const premature = await clientA.expectError("sessions.list");
  check(
    "requests before hello → error code not_paired",
    premature?.code === "not_paired",
    premature?.code,
  );

  const hello = await clientA.request("hello", {
    device_token: null,
    client: { name: "smoke", version: "1.0.0", platform: "node" },
  });
  check(
    "hello returns paired=true with a device token",
    hello.paired === true && typeof hello.device_token === "string",
    JSON.stringify(hello),
  );

  const ping = await clientA.request("ping", { ts: 1234 });
  check(
    "ping echoes ts and returns server_time",
    ping.ts === 1234 && typeof ping.server_time === "number",
  );

  const send1 = await clientA.request("chat.send", { session_id: null, text: "hello there" });
  check(
    "chat.send returns session_id and turn_id",
    typeof send1.session_id === "string" && typeof send1.turn_id === "string",
  );

  const userEcho = await clientA.nextEvent("message");
  check(
    "the user message is echoed before any assistant output",
    userEcho.event.role === "user" && userEcho.event.text === "hello there",
    JSON.stringify(userEcho.event),
  );

  let streamed = "";
  let finalMessage = null;
  let turnEnd = null;
  while (!turnEnd) {
    const frame = await clientA.nextAnyEvent(8000);
    if (frame.type === "delta") streamed += frame.event.text_delta;
    if (frame.type === "message" && frame.event.role === "assistant") finalMessage = frame.event;
    if (frame.type === "turn.end") turnEnd = frame.event;
  }
  check("streamed deltas arrive", streamed.length > 0);
  check(
    "the final message event carries exactly the streamed text",
    finalMessage !== null && finalMessage.text === streamed,
  );
  check("the turn ends with status completed", turnEnd.status === "completed", JSON.stringify(turnEnd));

  const list = await clientA.request("sessions.list", {});
  check(
    "sessions.list contains the new session",
    list.sessions.some((session) => session.id === send1.session_id),
  );

  const history = await clientA.request("sessions.history", { session_id: send1.session_id });
  check(
    "sessions.history returns the user + assistant transcript",
    history.messages.length === 2 &&
      history.messages[0].role === "user" &&
      history.messages[1].role === "assistant",
  );

  const memory = await clientA.request("memory.stats", {});
  const memoryFields = [
    "enabled",
    "episodes",
    "memories",
    "edges",
    "pending_episodes",
    "memory_uses_total",
    "memories_never_used",
    "consolidation_cursor",
    "consolidation_last_attempt_at",
    "consolidation_last_ok_at",
    "consolidation_last_error",
    "db_bytes",
    "wal_bytes",
    "last_checkpoint",
    "last_snapshot",
  ];
  check(
    "memory.stats exposes the frozen /health memory field set",
    memoryFields.every((field) => field in memory),
    JSON.stringify(Object.keys(memory)),
  );

  const cron = await clientA.request("cron.list", {});
  check("cron.list returns jobs", Array.isArray(cron.jobs) && cron.jobs.length >= 1);

  const unknown = await clientA.expectError("nonsense.frame");
  check("unknown request types → error code unsupported", unknown?.code === "unsupported", unknown?.code);

  const longSend = await clientA.request("chat.send", {
    session_id: send1.session_id,
    text: "long story please",
  });
  await clientA.nextEvent("delta");
  const busy = await clientA.expectError("chat.send", {
    session_id: send1.session_id,
    text: "second turn",
  });
  check("a second chat.send during a turn → busy", busy?.code === "busy", busy?.code);

  const ack = await clientA.request("turn.interrupt", {
    session_id: send1.session_id,
    turn_id: longSend.turn_id,
  });
  check("turn.interrupt acknowledges", ack.interrupted === true);

  let interrupted = null;
  while (!interrupted) {
    const frame = await clientA.nextAnyEvent(5000);
    if (frame.type === "turn.end") interrupted = frame.event;
  }
  check("the interrupted turn ends with status interrupted", interrupted.status === "interrupted");

  const toolSend = await clientA.request("chat.send", {
    session_id: send1.session_id,
    text: "please run a tool for me",
  });
  const approval = await clientA.nextEvent("approval", 5000);
  check(
    "a tool message triggers an approval event",
    typeof approval.event.approval_id === "string" && approval.event.tool === "shell.exec",
  );
  await clientA.request("approve", { approval_id: approval.event.approval_id });

  let sawToolEnd = false;
  let sawFileEdit = false;
  let toolTurnEnd = null;
  while (!toolTurnEnd) {
    const frame = await clientA.nextAnyEvent(8000);
    if (frame.type === "tool" && frame.event.phase === "end") sawToolEnd = true;
    if (frame.type === "file_edit" && frame.event.phase === "end") sawFileEdit = true;
    if (frame.type === "turn.end") toolTurnEnd = frame.event;
  }
  check("after approve, the tool runs to completion", sawToolEnd);
  check("file_edit events follow the approved tool", sawFileEdit);
  check("the tool turn completes once", toolTurnEnd.status === "completed");

  clientA.close();

  // --- gateway B: pairing handshake ---------------------------------------------

  const portB = await freePort();
  gatewayB = startGateway([
    "--port",
    String(portB),
    "--require-pairing",
    "--pairing-delay",
    "250",
    "--quiet",
  ]);
  clientB = await new TestClient(`ws://127.0.0.1:${portB}`).open();

  const helloB = await clientB.request("hello", {
    device_token: null,
    client: { name: "smoke", version: "1.0.0" },
  });
  check(
    "hello without a token returns paired=false plus a pairing code",
    helloB.paired === false && typeof helloB.pairing?.code === "string",
    JSON.stringify(helloB),
  );

  const gated = await clientB.expectError("sessions.list");
  check("requests before pairing → error code not_paired", gated?.code === "not_paired", gated?.code);

  const approved = await clientB.nextEvent("pairing.approved", 4000);
  check(
    "pairing.approved carries the device token after the owner approves",
    typeof approved.event.device_token === "string",
  );

  const helloAgain = await clientB.request("hello", {
    device_token: approved.event.device_token,
    client: { name: "smoke", version: "1.0.0" },
  });
  check("hello with the approved token → paired=true", helloAgain.paired === true);

  clientB.close();

  // --- gateway C: attachment uploads + chat.send wiring --------------------------

  const portC = await freePort();
  gatewayC = startGateway(["--port", String(portC), "--quiet"]);
  clientC = await new TestClient(`ws://127.0.0.1:${portC}`).open();
  await clientC.request("hello", {
    device_token: null,
    client: { name: "smoke", version: "1.0.0", platform: "node" },
  });

  const fixture = (name, mime, kind, contents) => ({
    name,
    mime,
    kind,
    bytes: Buffer.from(contents, "utf8"),
  });
  const imageFixture = fixture("photo.jpg", "image/jpeg", "image", "fake-jpeg-bytes-0123456789");
  const audioFixture = fixture("note.webm", "audio/webm", "audio", "fake-webm-audio");
  const fileFixture = fixture("paper.pdf", "application/pdf", "file", "pdf");

  const upload = (client, item) =>
    client.request("media.upload", {
      name: item.name,
      mime: item.mime,
      kind: item.kind,
      data: item.bytes.toString("base64"),
    });

  const uploadedMetadata = (uploaded, item) => ({
    attachment_id: uploaded.attachment_id,
    name: item.name,
    mime: item.mime,
    kind: item.kind,
    size: item.bytes.length,
  });
  const matchesMetadata = (actual, expected) =>
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((want, index) =>
      ["attachment_id", "name", "mime", "kind", "size"].every(
        (field) => actual[index]?.[field] === want[field],
      ),
    );

  const imageUpload = await upload(clientC, imageFixture);
  const audioUpload = await upload(clientC, audioFixture);
  const fileUpload = await upload(clientC, fileFixture);
  const uploadedIds = [
    imageUpload.attachment_id,
    audioUpload.attachment_id,
    fileUpload.attachment_id,
  ];
  check(
    "three media.upload calls return distinct attachment ids",
    uploadedIds.every(
      (attachmentId) => typeof attachmentId === "string" && attachmentId.startsWith("att-"),
    ) && new Set(uploadedIds).size === 3,
    JSON.stringify(uploadedIds),
  );
  check(
    "media.upload size is the decoded base64 byte length",
    imageUpload.size === imageFixture.bytes.length &&
      audioUpload.size === audioFixture.bytes.length &&
      fileUpload.size === fileFixture.bytes.length,
    JSON.stringify([imageUpload.size, audioUpload.size, fileUpload.size]),
  );

  const attachedSend = await clientC.request("chat.send", {
    session_id: null,
    text: "what is this?",
    attachments: uploadedIds,
  });
  const attachedEcho = await clientC.nextEvent("message");
  check(
    "the user echo carries the attachment metadata for a chat.send with ids",
    attachedEcho.event.role === "user" &&
      attachedEcho.event.text === "what is this?" &&
      matchesMetadata(attachedEcho.event.attachments, [
        uploadedMetadata(imageUpload, imageFixture),
        uploadedMetadata(audioUpload, audioFixture),
        uploadedMetadata(fileUpload, fileFixture),
      ]),
    JSON.stringify(attachedEcho.event),
  );

  const attachedFrames = await collectTurn(clientC);
  const attachedAnswer = attachedFrames.find(
    (frame) => frame.type === "message" && frame.event.role === "assistant",
  );
  const attachedTurnEnd = attachedFrames.find((frame) => frame.type === "turn.end");
  check(
    "the canned answer acknowledges the attachments by name and kind",
    Boolean(
      attachedAnswer?.event.text.includes(
        "Got 3 attachments: photo.jpg (image), note.webm (audio), paper.pdf (file)",
      ),
    ),
    JSON.stringify(attachedAnswer?.event.text),
  );
  check("the attachment turn completes normally", attachedTurnEnd?.event.status === "completed");

  const unknownAttachment = await clientC.expectError("chat.send", {
    session_id: attachedSend.session_id,
    text: "unknown attachment",
    attachments: ["att-nope"],
  });
  check(
    "chat.send with an unknown attachment id → no_attachment",
    unknownAttachment?.code === "no_attachment",
    unknownAttachment?.code,
  );

  await clientC.request("chat.send", {
    session_id: attachedSend.session_id,
    text: "marker after the rejected send",
  });
  const markerEcho = await clientC.nextEvent("message");
  check(
    "the rejected send produced no user echo",
    markerEcho.event.text === "marker after the rejected send",
    JSON.stringify(markerEcho.event),
  );
  await collectTurn(clientC);

  const reusedAttachment = await clientC.expectError("chat.send", {
    session_id: attachedSend.session_id,
    text: "reuse the ids",
    attachments: [imageUpload.attachment_id],
  });
  check(
    "a consumed attachment id → no_attachment on a later send",
    reusedAttachment?.code === "no_attachment",
    reusedAttachment?.code,
  );

  const pdfAgain = await upload(clientC, fileFixture);
  const emptyTextSend = await clientC.request("chat.send", {
    session_id: attachedSend.session_id,
    text: "",
    attachments: [pdfAgain.attachment_id],
  });
  check(
    "chat.send accepts empty text when at least one attachment is present",
    typeof emptyTextSend.turn_id === "string",
  );
  const emptyEcho = await clientC.nextEvent("message");
  check(
    'the empty-text echo carries text "" plus the attachment metadata',
    emptyEcho.event.role === "user" &&
      emptyEcho.event.text === "" &&
      matchesMetadata(emptyEcho.event.attachments, [uploadedMetadata(pdfAgain, fileFixture)]),
    JSON.stringify(emptyEcho.event),
  );
  const emptyTurnEnd = (await collectTurn(clientC)).find((frame) => frame.type === "turn.end");
  check("the empty-text attachment turn completes", emptyTurnEnd?.event.status === "completed");

  const emptyWithoutAttachments = await clientC.expectError("chat.send", {
    session_id: attachedSend.session_id,
    text: "",
  });
  check(
    "empty text with no attachments still → bad_request",
    emptyWithoutAttachments?.code === "bad_request",
    emptyWithoutAttachments?.code,
  );

  const badKind = await clientC.expectError("media.upload", {
    name: "run.exe",
    mime: "application/octet-stream",
    kind: "executable",
    data: "AAAA",
  });
  check(
    "media.upload with a kind outside the frozen set → bad_request",
    badKind?.code === "bad_request",
    badKind?.code,
  );

  const badBase64 = await clientC.expectError("media.upload", {
    name: "pixel.png",
    mime: "image/png",
    kind: "image",
    data: "data:image/png;base64,AAAA",
  });
  check(
    "media.upload with a prefixed/whitespaced payload → bad_request",
    badBase64?.code === "bad_request",
    badBase64?.code,
  );

  clientC2 = await new TestClient(`ws://127.0.0.1:${portC}`).open();
  await clientC2.request("hello", {
    device_token: null,
    client: { name: "smoke", version: "1.0.0", platform: "node" },
  });
  const foreignUpload = await upload(clientC, fileFixture);
  const foreign = await clientC2.expectError("chat.send", {
    session_id: null,
    text: "foreign attachment",
    attachments: [foreignUpload.attachment_id],
  });
  check(
    "an id uploaded on one connection → no_attachment on a second connection",
    foreign?.code === "no_attachment",
    foreign?.code,
  );

  // --- gateway E: v1.2 frames — hello limits, replaced, continued, history records ----

  const helloLimits = await clientC.request("hello", {
    device_token: null,
    client: { name: "smoke", version: "1.0.0", platform: "node" },
  });
  check(
    "hello advertises limits.max_upload_bytes and max_fetch_bytes",
    helloLimits.limits?.max_upload_bytes === 25 * 1024 * 1024 &&
      helloLimits.limits?.max_fetch_bytes === 25 * 1024 * 1024 &&
      Array.isArray(helloLimits.features) &&
      helloLimits.features.includes("chat.inject"),
    JSON.stringify({ limits: helloLimits.limits, features: helloLimits.features }),
  );

  const pairingLimits = await (clientB2 = await new TestClient(`ws://127.0.0.1:${portB}`).open()).request(
    "hello",
    {
      device_token: "not-the-approved-token",
      client: { name: "smoke", version: "1.0.0", platform: "node" },
    },
  );
  check(
    "the pairing branch of hello advertises limits too",
    pairingLimits.paired === false &&
      pairingLimits.limits?.max_upload_bytes === 25 * 1024 * 1024 &&
      pairingLimits.limits?.max_fetch_bytes === 25 * 1024 * 1024 &&
      Array.isArray(pairingLimits.features) &&
      pairingLimits.features.includes("chat.inject"),
    JSON.stringify({ paired: pairingLimits.paired, limits: pairingLimits.limits }),
  );

  const attachedHistory = await clientC.request("sessions.history", {
    session_id: attachedSend.session_id,
  });
  check(
    "history repeats the attachment records for a reloaded session",
    JSON.stringify(attachedHistory.messages[0]?.attachments) ===
      JSON.stringify(attachedEcho.event.attachments) &&
      !attachedHistory.messages.some((message) => /\[(image|audio|video|file):/.test(message.text)),
    JSON.stringify(attachedHistory.messages[0]),
  );

  const discardSend = await clientC.request("chat.send", {
    session_id: null,
    text: "discard the draft answer",
  });
  const discardFrames = await collectTurn(clientC);
  const replacedFrame = discardFrames.find(
    (frame) => frame.type === "message" && frame.event?.replaced === true,
  );
  const discardedIds = new Set(
    discardFrames.filter((frame) => frame.type === "delta").map((frame) => frame.event.message_id),
  );
  check(
    "a discarded segment closes with replaced:true on the already-streamed id",
    replacedFrame?.event.role === "assistant" &&
      replacedFrame?.event.text === "" &&
      discardedIds.has(replacedFrame?.event.message_id),
    JSON.stringify(replacedFrame?.event),
  );
  const discardFinal = discardFrames.find(
    (frame) => frame.type === "message" && frame.event.role === "assistant" && !frame.event.replaced,
  );
  check(
    "the regenerated answer uses a fresh message id",
    typeof discardFinal?.event.message_id === "string" &&
      discardFinal.event.message_id !== replacedFrame?.event.message_id &&
      discardFinal.event.text.startsWith("Got it"),
    JSON.stringify({ replaced: replacedFrame?.event.message_id, final: discardFinal?.event.message_id }),
  );
  check(
    "the discard turn ends exactly once with completed",
    discardFrames.filter((frame) => frame.type === "turn.end").length === 1 &&
      discardFrames.at(-1)?.event.status === "completed",
    JSON.stringify(discardFrames.filter((frame) => frame.type === "turn.end")),
  );
  check(
    "discarded text never reaches history",
    (
      await clientC.request("sessions.history", { session_id: discardSend.session_id })
    ).messages.every((message) => !message.text.includes("about to discard")),
  );

  const recoverSend = await clientC.request("chat.send", {
    session_id: null,
    text: "recover the long answer",
  });
  const recoverFrames = await collectTurn(clientC);
  const recoverDeltas = recoverFrames.filter((frame) => frame.type === "delta");
  const recoverFinal = recoverFrames.find(
    (frame) => frame.type === "message" && frame.event.role === "assistant",
  );
  const recoverIds = new Set(recoverDeltas.map((frame) => frame.event.message_id));
  const recoverText = recoverDeltas.map((frame) => frame.event.text_delta).join("");
  check(
    "a recovered answer never sends replaced",
    !recoverFrames.some((frame) => frame.event?.replaced === true),
  );
  check(
    "a recovered answer streams and finalizes under one message id",
    recoverIds.size === 1 && recoverFinal?.event.message_id === [...recoverIds][0],
    JSON.stringify([...recoverIds]),
  );
  check(
    "the final message equals the concatenated segments",
    recoverFinal?.event.text === recoverText &&
      recoverText.startsWith("First segment of a recovered answer.") &&
      recoverText.endsWith("Second segment continues the answer."),
    JSON.stringify(recoverFinal?.event.text),
  );

  const recoverHistory = await clientC.request("sessions.history", {
    session_id: recoverSend.session_id,
  });
  const recovered = recoverHistory.messages;
  check(
    "history folds a recovered answer into two entries, the second marked continued",
    recovered.length === 3 &&
      recovered[1].role === "assistant" &&
      recovered[1].continued === undefined &&
      recovered[2].role === "assistant" &&
      recovered[2].continued === true &&
      recovered[1].text + recovered[2].text === recoverText,
    JSON.stringify(recovered),
  );
  const recoverList = await clientC.request("sessions.list");
  const recoverEntry = recoverList.sessions.find((session) => session.id === recoverSend.session_id);
  check(
    "the recovered session counts only visible entries",
    recoverEntry?.message_count === 3 &&
      recovered.every((message) => !message.text.toLowerCase().includes("cut off")),
    JSON.stringify({ count: recoverEntry?.message_count, messages: recovered }),
  );

  const voiceNote = await clientC.request("media.upload", {
    name: "voice-note.webm",
    mime: "audio/webm",
    kind: "audio",
    data: Buffer.from("fake-voice-note", "utf8").toString("base64"),
    duration_ms: 3200,
  });
  check(
    "media.upload echoes duration_ms and omits it when absent",
    voiceNote.duration_ms === 3200 && imageUpload.duration_ms === undefined,
    JSON.stringify({ voice: voiceNote.duration_ms, image: imageUpload.duration_ms }),
  );

  const voiceSend = await clientC.request("chat.send", {
    session_id: null,
    text: "transcribe this note",
    attachments: [voiceNote.attachment_id],
  });
  const voiceEcho = await clientC.nextEvent("message");
  check(
    "the live echo carries duration_ms for a voice note",
    voiceEcho.event.attachments?.[0]?.duration_ms === 3200,
    JSON.stringify(voiceEcho.event.attachments),
  );
  await collectTurn(clientC);
  const voiceHistory = await clientC.request("sessions.history", {
    session_id: voiceSend.session_id,
  });
  check(
    "history returns the same attachment records, duration included",
    JSON.stringify(voiceHistory.messages[0]?.attachments) ===
      JSON.stringify(voiceEcho.event.attachments),
    JSON.stringify(voiceHistory.messages[0]),
  );

  const fetchedImage = await clientC.request("media.fetch", {
    session_id: attachedSend.session_id,
    attachment_id: imageUpload.attachment_id,
  });
  check(
    "media.fetch returns the stored bytes of a referenced attachment",
    fetchedImage.attachment_id === imageUpload.attachment_id &&
      fetchedImage.name === imageFixture.name &&
      fetchedImage.kind === "image" &&
      fetchedImage.size === imageFixture.bytes.length &&
      Buffer.from(fetchedImage.data ?? "", "base64").equals(imageFixture.bytes),
    JSON.stringify({ ...fetchedImage, data: `<${fetchedImage.data?.length ?? 0} chars>` }),
  );

  const fetchedVoice = await clientC.request("media.fetch", {
    session_id: voiceSend.session_id,
    attachment_id: voiceNote.attachment_id,
  });
  check(
    "media.fetch repeats duration_ms and the stored size",
    fetchedVoice.duration_ms === 3200 && fetchedVoice.size === voiceNote.size,
    JSON.stringify({ ...fetchedVoice, data: undefined }),
  );

  const goneFetch = await clientC.expectError("media.fetch", {
    session_id: "s-old-photo",
    attachment_id: "att-preupgrade01",
  });
  check(
    "an attachment whose stored file is gone → media_gone",
    goneFetch?.code === "media_gone",
    goneFetch?.code,
  );

  const foreignFetch = await clientC.expectError("media.fetch", {
    session_id: voiceSend.session_id,
    attachment_id: imageUpload.attachment_id,
  });
  check(
    "an id only another session references → no_attachment",
    foreignFetch?.code === "no_attachment",
    foreignFetch?.code,
  );

  const fetchUnknownSession = await clientC.expectError("media.fetch", {
    session_id: "s-does-not-exist",
    attachment_id: imageUpload.attachment_id,
  });
  check(
    "fetching from an unknown session → no_session",
    fetchUnknownSession?.code === "no_session",
    fetchUnknownSession?.code,
  );

  const fetchNoId = await clientC.expectError("media.fetch", { session_id: voiceSend.session_id });
  check("media.fetch without an id → bad_request", fetchNoId?.code === "bad_request", fetchNoId?.code);

  // Busy handling: a rejected send must not consume an attachment, and the
  // session must be usable again as soon as the running turn ends.
  const busyUpload = await clientC.request("media.upload", {
    name: "busy.bin",
    mime: "application/octet-stream",
    kind: "file",
    data: Buffer.from("busy-fixture", "utf8").toString("base64"),
  });
  const slowTurn = await clientC.request("chat.send", { session_id: null, text: "long spin" });
  const busySend = await clientC.expectError("chat.send", {
    session_id: slowTurn.session_id,
    text: "too soon",
    attachments: [busyUpload.attachment_id],
  });
  check(
    "a send while a turn is running → busy",
    busySend?.code === "busy",
    busySend?.code,
  );
  const staleStop = await clientC.expectError("turn.interrupt", {
    session_id: slowTurn.session_id,
    turn_id: "turn-not-real",
  });
  check(
    "interrupting a turn that is no longer the running one → no_turn",
    staleStop?.code === "no_turn",
    staleStop?.code,
  );
  await clientC.request("turn.interrupt", {
    session_id: slowTurn.session_id,
    turn_id: slowTurn.turn_id,
  });
  await collectTurn(clientC);
  const afterBusy = await clientC.request("chat.send", {
    session_id: slowTurn.session_id,
    text: "now it fits",
    attachments: [busyUpload.attachment_id],
  });
  check(
    "a busy rejection leaves the attachment usable",
    typeof afterBusy.turn_id === "string",
    JSON.stringify(afterBusy),
  );
  await collectTurn(clientC);

  // Steering: text for a session whose turn is running joins that answer.
  const injectTurn = await clientC.request("chat.send", {
    session_id: null,
    text: "answer with steering",
  });
  await clientC.nextEvent("message"); // the chat.send user echo
  const injected = await clientC.request("chat.inject", {
    session_id: injectTurn.session_id,
    text: "prefer the CLI",
  });
  check(
    "chat.inject acknowledges with the running turn id",
    injected.session_id === injectTurn.session_id && injected.turn_id === injectTurn.turn_id,
    JSON.stringify(injected),
  );
  const injectedEcho = await clientC.nextEvent("message");
  check(
    "the injected text is echoed on the running turn",
    injectedEcho.event.role === "user" &&
      injectedEcho.event.text === "prefer the CLI" &&
      injectedEcho.event.turn_id === injectTurn.turn_id,
    JSON.stringify(injectedEcho.event),
  );
  const injectFrames = await collectTurn(clientC);
  const injectAnswer = injectFrames.find(
    (frame) => frame.type === "message" && frame.event.role === "assistant",
  );
  check(
    "the running answer absorbs the injection",
    typeof injectAnswer?.event.text === "string" &&
      injectAnswer.event.text.includes('Noted: "prefer the CLI"'),
    JSON.stringify(injectAnswer?.event.text),
  );
  check(
    "an injection does not start or end an extra turn",
    injectFrames.filter((frame) => frame.type === "turn.end").length === 1 &&
      injectFrames.at(-1)?.event.turn_id === injectTurn.turn_id,
    JSON.stringify(injectFrames.filter((frame) => frame.type === "turn.end")),
  );

  const lateInject = await clientC.expectError("chat.inject", {
    session_id: injectTurn.session_id,
    text: "too late",
  });
  check("injecting with no running turn → no_turn", lateInject?.code === "no_turn", lateInject?.code);
  const injectMissingSession = await clientC.expectError("chat.inject", {
    session_id: "s-does-not-exist",
    text: "hello?",
  });
  check(
    "injecting into an unknown session → no_session",
    injectMissingSession?.code === "no_session",
    injectMissingSession?.code,
  );
  const emptyInject = await clientC.expectError("chat.inject", {
    session_id: injectTurn.session_id,
    text: "   ",
  });
  check("injecting empty text → bad_request", emptyInject?.code === "bad_request", emptyInject?.code);

  // --- gateway D: short-lived mock with a tiny upload cap -------------------------

  const portD = await freePort();
  gatewayD = startGateway(["--port", String(portD), "--max-upload-mb", "0.0005", "--quiet"]);
  clientD = await new TestClient(`ws://127.0.0.1:${portD}`).open();
  await clientD.request("hello", {
    device_token: null,
    client: { name: "smoke", version: "1.0.0", platform: "node" },
  });

  const tinyCap = Math.floor(0.0005 * 1024 * 1024);
  const tinyUnder = await clientD.request("media.upload", {
    name: "small.bin",
    mime: "application/octet-stream",
    kind: "file",
    data: Buffer.alloc(100, 7).toString("base64"),
  });
  check(
    "a gateway started with --max-upload-mb 0.0005 accepts a 100-byte upload",
    tinyUnder.size === 100,
    String(tinyUnder.size),
  );

  const tinyOver = await clientD.expectError("media.upload", {
    name: "big.bin",
    mime: "application/octet-stream",
    kind: "file",
    data: Buffer.alloc(600, 7).toString("base64"),
  });
  check(
    "a mock with --max-upload-mb 0.0005 returns too_large + details.limit_bytes for 600 bytes",
    tinyOver?.code === "too_large" && tinyOver?.details?.limit_bytes === tinyCap,
    JSON.stringify({ code: tinyOver?.code, details: tinyOver?.details }),
  );
  clientD.close();

  // --- gateway F: a fetch cap smaller than the stored file -------------------------

  const portF = await freePort();
  gatewayF = startGateway(["--port", String(portF), "--max-fetch-mb", "0.0005", "--quiet"]);
  clientF = await new TestClient(`ws://127.0.0.1:${portF}`).open();
  await clientF.request("hello", {
    device_token: null,
    client: { name: "smoke", version: "1.0.0", platform: "node" },
  });

  const fetchCapFixture = Buffer.alloc(600, 9);
  const capUpload = await clientF.request("media.upload", {
    name: "larger.bin",
    mime: "application/octet-stream",
    kind: "file",
    data: fetchCapFixture.toString("base64"),
  });
  const capSend = await clientF.request("chat.send", {
    session_id: null,
    text: "store this",
    attachments: [capUpload.attachment_id],
  });
  await collectTurn(clientF);
  const capFetch = await clientF.expectError("media.fetch", {
    session_id: capSend.session_id,
    attachment_id: capUpload.attachment_id,
  });
  check(
    "a stored file past the fetch cap → too_large + details.limit_bytes",
    capFetch?.code === "too_large" &&
      capFetch?.details?.limit_bytes === Math.floor(0.0005 * 1024 * 1024),
    JSON.stringify({ code: capFetch?.code, details: capFetch?.details }),
  );
  clientF.close();
} catch (error) {
  failures.push(`unexpected exception: ${error?.stack ?? error}`);
  console.error(error);
} finally {
  clientA?.close();
  clientB?.close();
  clientB2?.close();
  clientC?.close();
  clientC2?.close();
  clientD?.close();
  clientF?.close();
  gatewayA.kill();
  gatewayB?.kill();
  gatewayC?.kill();
  gatewayD?.kill();
  gatewayF?.kill();
  await sleep(100);
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.error(`failed: ${failures.join("; ")}`);
  process.exit(1);
}
process.exit(0);
