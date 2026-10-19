#!/usr/bin/env node
// dev/mock-gateway.mjs — a small reference implementation of docs/protocol.md.
//
// Purpose: develop and test the MasonDesk UI without Rust, without the framework, and
// without a VPS. It is also the executable half of the protocol contract — `dev/smoke.mjs`
// asserts that this server behaves exactly as the document says.
//
// Usage:
//   node dev/mock-gateway.mjs [--port 18790] [--require-pairing] [--pairing-delay 8000]
//                             [--token mock-device-token] [--max-upload-mb 25]
//                             [--max-fetch-mb 25] [--quiet]
//
// Message behaviour:
//   "tool" anywhere in a message  → approval flow → tool + file_edit events
//   "long" anywhere in a message  → a long stream, useful for testing turn.interrupt
//   "recover" anywhere in a message → a truncated answer: both segments stream under one
//                                     message id; history keeps two entries, the second
//                                     marked continued:true
//   "discard" anywhere in a message → a discarded segment: the streamed draft is closed with
//                                     a message frame carrying replaced:true, then the answer
//                                     regenerates under a fresh message id
//   chat.inject (a separate frame)   → text joins the running answer at the next chunk
//                                     boundary; echoed as a user message on the same turn
//
// Attachments:
//   media.upload decodes standard base64 and keeps the bytes on the uploading connection for
//   15 minutes. chat.send consumes the ids once and echoes their metadata on the user message;
//   sessions.history repeats those records so a reloaded session keeps its chips.
//   Over-cap uploads fail with too_large and details.limit_bytes; hello announces
//   limits.max_upload_bytes on both branches.
//   media.fetch serves the stored bytes of an attachment a session references (so a reloaded
//   transcript can render its thumbnails); hello announces limits.max_fetch_bytes, an id whose
//   bytes are gone answers media_gone, and one past the cap answers too_large.

import { WebSocketServer } from "ws";

const PROTOCOL_VERSION = 1;
const HELLO_TIMEOUT_MS = 10_000;
const APPROVAL_TIMEOUT_MS = 30_000;
const ATTACHMENT_TTL_MS = 15 * 60 * 1000;
const ATTACHMENT_KINDS = new Set(["image", "audio", "video", "file"]);

// --- flags ---------------------------------------------------------------------

const flags = {};
{
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
}

const PORT = Number(flags.port ?? 18790);
const TOKEN = typeof flags.token === "string" ? flags.token : "mock-device-token";
const REQUIRE_PAIRING = Boolean(flags["require-pairing"]);
const PAIRING_DELAY = Number(flags["pairing-delay"] ?? 8000);
const QUIET = Boolean(flags.quiet);
const MAX_UPLOAD_MB = (() => {
  const value = typeof flags["max-upload-mb"] === "string" ? Number(flags["max-upload-mb"]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 25;
})();
const MAX_UPLOAD_BYTES = Math.floor(MAX_UPLOAD_MB * 1024 * 1024);

// `media.fetch` cap (bytes served in one frame) — the mirror of the framework's maxFetchMb.
const MAX_FETCH_MB = (() => {
  const value = typeof flags["max-fetch-mb"] === "string" ? Number(flags["max-fetch-mb"]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 25;
})();
const MAX_FETCH_BYTES = Math.floor(MAX_FETCH_MB * 1024 * 1024);

const log = (...parts) => {
  if (!QUIET) console.log(`[mock ${new Date().toISOString().slice(11, 19)}]`, ...parts);
};

// --- protocol helpers -------------------------------------------------------------

const ok = (id, result) => ({ v: PROTOCOL_VERSION, id, ok: true, result });
const fail = (id, code, message, details) => ({
  v: PROTOCOL_VERSION,
  id,
  ok: false,
  error: { code, message, ...(details === undefined ? {} : { details }) },
});
const event = (type, payload) => ({ v: PROTOCOL_VERSION, type, event: payload });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (conn) => conn.socket.readyState === 1;

function send(conn, frame) {
  if (!alive(conn)) return;
  conn.socket.send(JSON.stringify(frame));
}

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (index === 3) code += "-";
  }
  return code;
}

// Standard base64 only: no data: prefix, no whitespace, padded to a multiple of 4.
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64(data) {
  if (typeof data !== "string" || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) return null;
  return Buffer.from(data, "base64");
}

let attachmentSeq = 0;

function makeAttachmentId() {
  attachmentSeq += 1;
  const random = Math.floor(Math.random() * 0x1_0000)
    .toString(16)
    .padStart(4, "0");
  return `att-${random}${attachmentSeq.toString(16).padStart(2, "0")}`;
}

// --- state -------------------------------------------------------------------------

const sessions = new Map();
const histories = new Map();
// Bytes of attachments a session references, keyed by `${sessionId}:${attachmentId}`.
// Real gateways keep the file on disk; a missing entry is `media_gone`.
const mediaStore = new Map();

// Attachments are owned by the connection that uploaded them; chat.send consumes them once.
function takeAttachments(conn, attachmentIds) {
  const now = Date.now();
  const found = [];
  for (const attachmentId of attachmentIds) {
    const attachment = conn.attachments.get(attachmentId);
    if (!attachment || attachment.expires_at <= now) return null;
    found.push(attachment);
  }
  for (const attachment of found) conn.attachments.delete(attachment.attachment_id);
  return found;
}

function next3am() {
  const date = new Date();
  date.setHours(3, 0, 0, 0);
  if (date.getTime() < Date.now()) date.setDate(date.getDate() + 1);
  return date.getTime();
}

{
  const now = Date.now();
  const seed = (session, history) => {
    sessions.set(session.id, session);
    histories.set(session.id, history);
  };
  seed(
    {
      id: "s-welcome",
      title: "Welcome to MasonDesk",
      created_at: now - 90_000_000,
      updated_at: now - 88_000_000,
      message_count: 2,
      source: "desktop",
    },
    [
      { message_id: "m-1", role: "user", text: "What can you do?", ts: now - 90_000_000 },
      {
        message_id: "m-2",
        role: "assistant",
        text:
          "I stream replies, run tools and edit files — and this transcript was served by " +
          "sessions.history. Mention `tool` in a message to see the approval flow.",
        ts: now - 88_000_000,
        reasoning: [
          { text: "This is mock reasoning; the real channel forwards the agent's deltas." },
        ],
        tools: [{ name: "memory.search", ok: true, summary: "3 results" }],
        file_edits: [{ path: "~/.mason/workspace/SOUL.md", ok: true }],
      },
    ],
  );
  seed(
    {
      id: "s-cron-notes",
      title: "Nightly consolidation notes",
      created_at: now - 400_000_000,
      updated_at: now - 300_000_000,
      message_count: 0,
      source: "cron",
    },
    [],
  );
  // A transcript written before media.fetch existed: the record survives, the
  // bytes do not — fetching it answers `media_gone`.
  seed(
    {
      id: "s-old-photo",
      title: "An old photo",
      created_at: now - 60_000_000,
      updated_at: now - 50_000_000,
      message_count: 2,
      source: "desktop",
    },
    [
      {
        message_id: "m-old-1",
        role: "user",
        text: "what is on this photo?",
        ts: now - 60_000_000,
        attachments: [
          {
            attachment_id: "att-preupgrade01",
            name: "holiday.png",
            mime: "image/png",
            kind: "image",
            size: 4096,
          },
        ],
      },
      {
        message_id: "m-old-2",
        role: "assistant",
        text: "The stored file for this attachment is no longer available.",
        ts: now - 50_000_000,
      },
    ],
  );
}

const cronJobs = [
  {
    id: "c-nightly",
    name: "nightly-memory-consolidation",
    schedule: "0 3 * * *",
    enabled: true,
    next_run_at: next3am(),
    last_run_at: Date.now() - 86_400_000,
    last_status: "ok",
    payload_preview: "consolidate memories",
  },
  {
    id: "c-pulse",
    name: "hourly-pulse",
    schedule: "0 * * * *",
    enabled: true,
    next_run_at: Date.now() + 3_600_000,
    last_run_at: Date.now() - 1_800_000,
    last_status: "error",
    payload_preview: "check sources",
  },
  {
    id: "c-weekly",
    name: "weekly-soak",
    schedule: "30 6 * * 1",
    enabled: false,
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    payload_preview: "long soak run",
  },
];

let memoryUses = 0;

function memoryStats() {
  memoryUses += 1;
  const now = Date.now();
  return {
    enabled: true,
    episodes: 5,
    memories: 71 + (memoryUses % 3),
    edges: 12,
    pending_episodes: 0,
    memory_uses_total: memoryUses,
    memories_never_used: 4,
    consolidation_cursor: 5,
    consolidation_last_attempt_at: now - 3_600_000,
    consolidation_last_ok_at: now - 3_600_000,
    consolidation_last_error: null,
    db_bytes: 376_832,
    wal_bytes: 0,
    last_checkpoint: now - 7_200_000,
    last_snapshot: null,
  };
}

// --- server --------------------------------------------------------------------------

const server = new WebSocketServer({ host: "127.0.0.1", port: PORT });

server.on("listening", () => {
  log(`listening on ws://127.0.0.1:${PORT}${REQUIRE_PAIRING ? " (pairing required)" : ""}`);
  if (!QUIET) {
    console.log(`[mock] mock gateway ready — token ${TOKEN}`);
    console.log("[mock] triggers: tool · long · recover · discard  (any word form)");
  }
});

server.on("connection", (socket, request) => {
  const conn = {
    socket,
    helloSeen: false,
    paired: !REQUIRE_PAIRING,
    turns: new Map(),
    approvals: new Map(),
    attachments: new Map(),
    counter: 0,
  };
  log(`connection from ${request.socket.remoteAddress ?? "?"}`);

  const helloTimer = setTimeout(() => {
    if (!conn.helloSeen) {
      log("closing: no hello within 10 s (4408)");
      socket.close(4408, "hello timeout");
    }
  }, HELLO_TIMEOUT_MS);

  socket.on("message", (data) => {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    void handleFrame(conn, frame);
  });

  socket.on("error", (error) => {
    log(`socket error: ${error?.message ?? error}`);
  });

  socket.on("close", () => {
    clearTimeout(helloTimer);
    for (const turn of conn.turns.values()) turn.cancelled = true;
  });
});

async function handleFrame(conn, frame) {
  const id = typeof frame.id === "string" ? frame.id : null;
  const type = typeof frame.type === "string" ? frame.type : null;
  if (!id || !type) return;

  if (frame.v !== undefined && frame.v !== PROTOCOL_VERSION && type === "hello") {
    send(conn, fail(id, "protocol_mismatch", `this server speaks v${PROTOCOL_VERSION}`));
    conn.socket.close(4400, "protocol mismatch");
    return;
  }

  if ((!conn.helloSeen || !conn.paired) && type !== "hello" && type !== "ping") {
    send(conn, fail(id, "not_paired", "send a successful hello first"));
    return;
  }

  switch (type) {
    case "hello":
      handleHello(conn, id, frame);
      return;
    case "ping":
      send(conn, ok(id, { ts: frame.ts ?? null, server_time: Date.now() }));
      return;
    case "media.upload":
      handleMediaUpload(conn, id, frame);
      return;
    case "media.fetch":
      handleMediaFetch(conn, id, frame);
      return;
    case "chat.send":
      void handleChatSend(conn, id, frame);
      return;
    case "chat.inject":
      handleChatInject(conn, id, frame);
      return;
    case "turn.interrupt": {
      const turn = conn.turns.get(frame.session_id);
      if (!turn || turn.turnId !== frame.turn_id) {
        send(conn, fail(id, "no_turn", "no matching running turn"));
        return;
      }
      turn.cancelled = true;
      send(conn, ok(id, { interrupted: true }));
      return;
    }
    case "sessions.list": {
      const list = [...sessions.values()]
        .sort((a, b) => b.updated_at - a.updated_at)
        .map((session) => ({
          ...session,
          message_count: histories.get(session.id)?.length ?? session.message_count,
        }));
      send(conn, ok(id, { sessions: list, next_cursor: null }));
      return;
    }
    case "sessions.history": {
      const history = histories.get(frame.session_id);
      if (!history) {
        send(conn, fail(id, "no_session", `unknown session ${frame.session_id}`));
        return;
      }
      send(conn, ok(id, { session_id: frame.session_id, messages: history, next_cursor: null }));
      return;
    }
    case "memory.stats":
      send(conn, ok(id, memoryStats()));
      return;
    case "cron.list":
      send(conn, ok(id, { jobs: cronJobs }));
      return;
    case "approve":
    case "deny": {
      const approvalId = frame.approval_id;
      const resolve = conn.approvals.get(approvalId);
      if (!resolve) {
        send(conn, fail(id, "no_approval", `unknown approval ${approvalId}`));
        return;
      }
      conn.approvals.delete(approvalId);
      send(conn, ok(id, { approval_id: approvalId, approved: type === "approve" }));
      resolve(type === "approve");
      return;
    }
    default:
      send(conn, fail(id, "unsupported", `unknown request type: ${type}`));
  }
}

function handleHello(conn, id, frame) {
  conn.helloSeen = true;
  const token = typeof frame.device_token === "string" ? frame.device_token : null;
  // Advertised on both branches so a client knows its upload budget before pairing.
  const limits = { max_upload_bytes: MAX_UPLOAD_BYTES, max_fetch_bytes: MAX_FETCH_BYTES };
  const features = ["chat.inject"];

  if (!REQUIRE_PAIRING || token === TOKEN) {
    conn.paired = true;
    send(
      conn,
      ok(id, {
        protocol: PROTOCOL_VERSION,
        paired: true,
        device_token: TOKEN,
        gateway: { version: "mock-0.1.0", started_at: Date.now() - 120_000 },
        limits,
        features,
      }),
    );
    log("hello ok — paired");
    return;
  }

  const code = makeCode();
  send(
    conn,
    ok(id, {
      protocol: PROTOCOL_VERSION,
      paired: false,
      pairing: { code, expires_at: Date.now() + PAIRING_DELAY + 60_000 },
      reason: token ? "unknown" : "missing",
      limits,
      features,
    }),
  );
  log(`pairing code ${code} — approving in ${PAIRING_DELAY} ms (simulated 'mason pairing approve')`);
  setTimeout(() => {
    if (!alive(conn)) return;
    send(conn, event("pairing.approved", { device_token: TOKEN }));
    log(`approved ${code} → device token issued`);
  }, PAIRING_DELAY);
}

function handleMediaUpload(conn, id, frame) {
  const name = typeof frame.name === "string" ? frame.name : "";
  const mime = typeof frame.mime === "string" ? frame.mime : "";
  if (!name || !mime || !ATTACHMENT_KINDS.has(frame.kind)) {
    send(
      conn,
      fail(id, "bad_request", "media.upload requires name, mime and a kind in image|audio|video|file"),
    );
    return;
  }
  const bytes = decodeBase64(frame.data);
  if (bytes === null) {
    send(conn, fail(id, "bad_request", "data must be standard base64 without prefix or whitespace"));
    return;
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    send(
      conn,
      fail(id, "too_large", `upload is ${bytes.length} bytes; limit is ${MAX_UPLOAD_BYTES}`, {
        limit_bytes: MAX_UPLOAD_BYTES,
      }),
    );
    return;
  }

  const now = Date.now();
  for (const [attachmentId, attachment] of conn.attachments) {
    if (attachment.expires_at <= now) conn.attachments.delete(attachmentId);
  }

  const attachment = {
    attachment_id: makeAttachmentId(),
    name,
    mime,
    kind: frame.kind,
    size: bytes.length,
    bytes,
    expires_at: now + ATTACHMENT_TTL_MS,
  };
  const durationMs =
    typeof frame.duration_ms === "number" && Number.isFinite(frame.duration_ms) && frame.duration_ms >= 0
      ? Math.round(frame.duration_ms)
      : null;
  if (durationMs !== null) attachment.duration_ms = durationMs;
  conn.attachments.set(attachment.attachment_id, attachment);
  send(
    conn,
    ok(id, {
      attachment_id: attachment.attachment_id,
      name,
      mime,
      kind: attachment.kind,
      size: attachment.size,
      ...(durationMs !== null ? { duration_ms: durationMs } : {}),
    }),
  );
  log(`media.upload ${attachment.attachment_id}: ${name} (${attachment.kind}, ${bytes.length} bytes)`);
}

function handleMediaFetch(conn, id, frame) {
  const sessionId = typeof frame.session_id === "string" ? frame.session_id : "";
  const attachmentId = typeof frame.attachment_id === "string" ? frame.attachment_id : "";
  if (!sessionId || !attachmentId) {
    send(conn, fail(id, "bad_request", "media.fetch requires session_id and attachment_id"));
    return;
  }
  const history = histories.get(sessionId);
  if (!history) {
    send(conn, fail(id, "no_session", `unknown session ${sessionId}`));
    return;
  }
  // The id must be referenced by this session's transcript: ids from another
  // session (or an unsent upload) are indistinguishable from unknown ones.
  const record = history
    .flatMap((message) => message.attachments ?? [])
    .find((candidate) => candidate.attachment_id === attachmentId);
  if (!record) {
    send(conn, fail(id, "no_attachment", `session ${sessionId} does not reference ${attachmentId}`));
    return;
  }
  const bytes = mediaStore.get(`${sessionId}:${attachmentId}`);
  if (!bytes) {
    send(conn, fail(id, "media_gone", `the stored file for ${attachmentId} is gone`));
    return;
  }
  if (bytes.length > MAX_FETCH_BYTES) {
    send(
      conn,
      fail(id, "too_large", `stored file is ${bytes.length} bytes; fetch limit is ${MAX_FETCH_BYTES}`, {
        limit_bytes: MAX_FETCH_BYTES,
      }),
    );
    return;
  }
  send(
    conn,
    ok(id, {
      attachment_id: attachmentId,
      name: record.name,
      mime: record.mime,
      kind: record.kind,
      size: bytes.length,
      ...(record.duration_ms !== undefined ? { duration_ms: record.duration_ms } : {}),
      data: bytes.toString("base64"),
    }),
  );
  log(`media.fetch ${attachmentId} for ${sessionId}: ${bytes.length} bytes`);
}

// Steering: text for a session whose turn is already running is acknowledged with the
// running turn id and woven into that answer at the next chunk boundary. No turn starts.
function handleChatInject(conn, id, frame) {
  const sessionId = typeof frame.session_id === "string" ? frame.session_id : null;
  const text = typeof frame.text === "string" ? frame.text.trim() : "";
  if (!sessionId || !text) {
    send(conn, fail(id, "bad_request", "chat.inject requires session_id and text"));
    return;
  }
  if (!sessions.has(sessionId)) {
    send(conn, fail(id, "no_session", `unknown session ${sessionId}`));
    return;
  }
  const turn = conn.turns.get(sessionId);
  if (!turn) {
    send(conn, fail(id, "no_turn", "no turn is running for that session"));
    return;
  }
  turn.injections.push(text);
  const now = Date.now();
  const messageId = `m-u-${(conn.counter += 1)}`;
  histories.get(sessionId)?.push({ message_id: messageId, role: "user", text, ts: now });
  send(conn, ok(id, { session_id: sessionId, turn_id: turn.turnId }));
  send(
    conn,
    event("message", {
      session_id: sessionId,
      turn_id: turn.turnId,
      message_id: messageId,
      role: "user",
      text,
      ts: now,
    }),
  );
  log(`chat.inject → ${sessionId} / ${turn.turnId}: ${JSON.stringify(text.slice(0, 60))}`);
}

// Trigger words are matched on any common inflection so a test phrase never silently
// misses: "tools", "recovering", "discarded" all fire.
async function handleChatSend(conn, id, frame) {
  try {
    await runChatSend(conn, id, frame);
  } catch (error) {
    // A throw mid-turn must never wedge the session (or take the mock down).
    log(`chat.send failed: ${error?.message ?? error}`);
    conn.turns.clear();
    if (alive(conn)) {
      send(
        conn,
        event("turn.end", {
          session_id: typeof frame.session_id === "string" ? frame.session_id : null,
          turn_id: null,
          status: "error",
          error: "mock failure",
        }),
      );
    }
  }
}

async function runChatSend(conn, id, frame) {
  const text = typeof frame.text === "string" ? frame.text : "";
  const attachmentIds = frame.attachments === undefined ? [] : frame.attachments;
  if (
    !Array.isArray(attachmentIds) ||
    attachmentIds.some((attachmentId) => typeof attachmentId !== "string" || attachmentId === "")
  ) {
    send(conn, fail(id, "bad_request", "attachments must be an array of attachment ids"));
    return;
  }
  if (!text.trim() && attachmentIds.length === 0) {
    send(conn, fail(id, "bad_request", "text is required"));
    return;
  }
  let sessionId = typeof frame.session_id === "string" ? frame.session_id : null;
  if (sessionId && !sessions.has(sessionId)) {
    send(conn, fail(id, "no_session", `unknown session ${sessionId}`));
    return;
  }
  if (sessionId && conn.turns.has(sessionId)) {
    send(conn, fail(id, "busy", "a turn is already running for this session"));
    return;
  }

  // Resolve every id before consuming any of them, so a bad send changes nothing.
  const attachments = takeAttachments(conn, attachmentIds);
  if (attachments === null) {
    send(conn, fail(id, "no_attachment", "unknown, expired or foreign attachment id"));
    return;
  }

  const now = Date.now();
  const title = text.slice(0, 48) || attachments[0].name.slice(0, 48);
  if (!sessionId) {
    sessionId = `s-${now.toString(36)}`;
    sessions.set(sessionId, {
      id: sessionId,
      title,
      created_at: now,
      updated_at: now,
      message_count: 0,
      source: "desktop",
    });
    histories.set(sessionId, []);
  }

  const turnId = `t-${now.toString(36)}`;
  const turn = { turnId, cancelled: false, injections: [] };
  conn.turns.set(sessionId, turn);
  send(conn, ok(id, { session_id: sessionId, turn_id: turnId }));
  log(`chat.send → ${sessionId} / ${turnId}: ${JSON.stringify(text.slice(0, 60))}`);

  const history = histories.get(sessionId);
  for (const attachment of attachments) {
    // Keep the bytes addressable by the session that references them, so a
    // reloaded transcript can fetch them back (media.fetch).
    mediaStore.set(`${sessionId}:${attachment.attachment_id}`, attachment.bytes);
  }
  const userMessageId = `m-u-${(conn.counter += 1)}`;
  const userMessage = { message_id: userMessageId, role: "user", text, ts: now };
  if (attachments.length > 0) {
    userMessage.attachments = attachments.map(({ attachment_id, name: fileName, mime, kind, size, duration_ms }) => ({
      attachment_id,
      name: fileName,
      mime,
      kind,
      size,
      ...(duration_ms !== undefined ? { duration_ms } : {}),
    }));
  }
  history.push(userMessage);
  send(conn, event("message", { session_id: sessionId, turn_id: turnId, ...userMessage }));

  const assistantId = `m-a-${(conn.counter += 1)}`;
  const wantsTool = /\btools?\b/i.test(text);
  const long = /\blong\b/i.test(text);
  const tools = [];
  const fileEdits = [];

  // Reasoning stream.
  const reasoning = `Considering "${text.slice(0, 60)}" — mock reasoning, streamed as reasoning_delta frames.`;
  for (const word of reasoning.split(" ")) {
    if (turn.cancelled || !alive(conn)) break;
    send(
      conn,
      event("reasoning_delta", {
        session_id: sessionId,
        turn_id: turnId,
        message_id: assistantId,
        text_delta: `${word} `,
      }),
    );
    await sleep(long ? 30 : 12);
  }
  if (!turn.cancelled && alive(conn)) {
    send(conn, event("reasoning_end", { session_id: sessionId, turn_id: turnId, message_id: assistantId }));
  }

  // Approval + tool flow.
  if (!turn.cancelled && alive(conn) && wantsTool) {
    const approvalId = `a-${now.toString(36)}`;
    const verdict = new Promise((resolve) => conn.approvals.set(approvalId, resolve));
    send(
      conn,
      event("approval", {
        session_id: sessionId,
        turn_id: turnId,
        approval_id: approvalId,
        tool: "shell.exec",
        summary: `run a command related to "${text.slice(0, 40)}"`,
        args_preview: "echo hello && ls ~/.mason",
      }),
    );
    log(`approval ${approvalId} requested`);
    const decision = await Promise.race([
      verdict,
      sleep(APPROVAL_TIMEOUT_MS).then(() => "timeout"),
    ]);
    conn.approvals.delete(approvalId);
    const toolCallId = "tc-1";
    send(
      conn,
      event("tool", {
        session_id: sessionId,
        turn_id: turnId,
        tool_call_id: toolCallId,
        name: "shell.exec",
        phase: "start",
        args_preview: "echo hello",
      }),
    );
    await sleep(150);
    if (decision === true) {
      send(
        conn,
        event("tool", {
          session_id: sessionId,
          turn_id: turnId,
          tool_call_id: toolCallId,
          name: "shell.exec",
          phase: "end",
          ok: true,
          summary: "exit 0",
        }),
      );
      tools.push({ name: "shell.exec", ok: true, summary: "exit 0" });
      const path = "~/.mason/workspace/NOTES.md";
      send(conn, event("file_edit", { session_id: sessionId, turn_id: turnId, path, phase: "start" }));
      await sleep(120);
      if (alive(conn)) {
        send(
          conn,
          event("file_edit", {
            session_id: sessionId,
            turn_id: turnId,
            path,
            phase: "end",
            ok: true,
            diff_preview: "+ the mock gateway appended this line",
          }),
        );
      }
      fileEdits.push({ path, ok: true });
    } else {
      send(
        conn,
        event("tool", {
          session_id: sessionId,
          turn_id: turnId,
          tool_call_id: toolCallId,
          name: "shell.exec",
          phase: "error",
          ok: false,
          summary: decision === "timeout" ? "approval timed out" : "denied by user",
        }),
      );
    }
  }

  // Answer stream. Two trigger words mirror the framework's recovery paths:
  // `recover` is a truncated answer that continues under the same message id
  // (history keeps two entries, the second marked `continued`); `discard` is a
  // segment the server throws away and regenerates (a `replaced` frame on the
  // old id, then the answer under a fresh id).
  const recover = /\brecover(s|ing|ed|y)?\b/i.test(text);
  const discard = /\bdiscard(s|ing|ed)?\b/i.test(text);
  const parts = [];
  if (attachments.length > 0) {
    const list = attachments
      .map((attachment) => `${attachment.name} (${attachment.kind})`)
      .join(", ");
    parts.push(`Got ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}: ${list}.`);
  }
  parts.push(
    `Got it — you said "${text.slice(0, 80)}".`,
    "This reply is streamed by the mock gateway: deltas first, then the final message, then turn.end.",
    wantsTool
      ? "The tool call above went through the approval flow."
      : "Mention `tool` in a message to exercise the approval flow, or `long` to test interrupt.",
  );
  if (long) {
    parts.push(
      // ~100 lines → roughly 13 s of streaming, enough time to find and press Stop.
      "Long mode: this sentence repeats so the stream is long enough to interrupt. ".repeat(100),
    );
  }
  const answer = parts.join(" ");
  const segments = recover
    ? ["First segment of a recovered answer.", " Second segment continues the answer."]
    : [answer];

  let injectedText = "";

  /** Weave anything injected since the last chunk into the running answer. */
  const drainInjected = async (messageId) => {
    while (turn.injections.length > 0) {
      const note = ` Noted: "${turn.injections.shift()}".`;
      injectedText += note;
      for (const chunk of note.split(/(\s+)/).filter(Boolean)) {
        if (turn.cancelled || !alive(conn)) return;
        send(
          conn,
          event("delta", {
            session_id: sessionId,
            turn_id: turnId,
            message_id: messageId,
            text_delta: chunk,
          }),
        );
        await sleep(long ? 10 : 16);
      }
    }
  };

  const streamText = async (messageId, source) => {
    for (const chunk of source.split(/(\s+)/).filter(Boolean)) {
      if (turn.cancelled || !alive(conn)) return false;
      send(
        conn,
        event("delta", {
          session_id: sessionId,
          turn_id: turnId,
          message_id: messageId,
          text_delta: chunk,
        }),
      );
      await sleep(long ? 10 : 16);
      await drainInjected(messageId);
    }
    return true;
  };

  if (discard) {
    await streamText(assistantId, "Draft segment the server is about to discard.");
    if (!turn.cancelled && alive(conn)) {
      send(
        conn,
        event("message", {
          session_id: sessionId,
          turn_id: turnId,
          message_id: assistantId,
          role: "assistant",
          text: "",
          ts: Date.now(),
          replaced: true,
        }),
      );
      log(`replaced ${assistantId} (discarded segment)`);
    }
  }

  const finalId = discard ? `m-a-${(conn.counter += 1)}` : assistantId;
  const streamed = discard ? [answer] : segments;
  for (const segment of streamed) {
    if (!(await streamText(finalId, segment))) break;
  }
  await drainInjected(finalId);
  const finalText = streamed.join("") + injectedText;

  const status = turn.cancelled ? "interrupted" : "completed";
  if (status === "completed") {
    const entries = recover
      ? [
          { text: segments[0], reasoning: [{ text: reasoning }], tools, file_edits: fileEdits },
          { text: segments[1] + injectedText, continued: true },
        ]
      : [{ text: finalText, reasoning: [{ text: reasoning }], tools, file_edits: fileEdits }];
    entries.forEach((entry, index) => {
      history.push({
        message_id: index === 0 ? finalId : `m-a-${(conn.counter += 1)}`,
        role: "assistant",
        ts: Date.now(),
        ...entry,
      });
    });
    send(
      conn,
      event("message", {
        session_id: sessionId,
        turn_id: turnId,
        message_id: finalId,
        role: "assistant",
        text: finalText,
        ts: Date.now(),
      }),
    );
  }

  const session = sessions.get(sessionId);
  session.updated_at = Date.now();
  session.message_count = history.length;
  if (status === "completed" && session.title.startsWith(title)) {
    session.title = title;
  }

  send(
    conn,
    event("session.updated", {
      session_id: sessionId,
      title: session.title,
      updated_at: session.updated_at,
      message_count: session.message_count,
    }),
  );
  send(conn, event("turn.end", { session_id: sessionId, turn_id: turnId, status }));
  conn.turns.delete(sessionId);
  log(`turn ${turnId} ${status}`);
}
