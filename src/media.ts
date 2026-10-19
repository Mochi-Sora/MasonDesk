// Composer media: classify local files, read them as base64, upload them over the
// frozen protocol (docs/protocol.md §3.1), and capture voice notes.
//
// Everything here runs in the webview: the Tauri window and the dev browser both
// expose File and MediaRecorder, so no Rust command is involved.

import type { Client } from "./connection/client";
import {
  asString,
  makeId,
  type AttachmentKind,
  type AttachmentMeta,
  type GatewayLimits,
  type MediaFetchResult,
} from "./protocol";

/** Fallback pre-check: the gateway's `hello.limits.max_upload_bytes` wins when present. */
const DEFAULT_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 60_000;

let uploadLimitBytes = DEFAULT_UPLOAD_LIMIT_BYTES;
let fetchLimitBytes = 0;

/** Largest upload the gateway will accept, as last announced by `hello`. */
export function uploadLimit(): number {
  return uploadLimitBytes;
}

/** Largest attachment the gateway will serve over `media.fetch`; 0 = unsupported. */
export function fetchLimit(): number {
  return fetchLimitBytes;
}

/** True when the connected gateway understands `media.fetch`. */
export function fetchEnabled(): boolean {
  return fetchLimitBytes > 0;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/** Adopt the limits a `hello` result announced; missing values restore the defaults. */
export function adoptGatewayLimits(limits: GatewayLimits | null | undefined): void {
  uploadLimitBytes = positiveInt(limits?.max_upload_bytes) ?? DEFAULT_UPLOAD_LIMIT_BYTES;
  fetchLimitBytes = positiveInt(limits?.max_fetch_bytes) ?? 0;
}

export interface PendingAttachment {
  /** Local id, only used for rendering and removal. */
  id: string;
  file: File;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  durationMs?: number;
  previewUrl?: string;
  /** Set once uploaded, so a retry does not upload the bytes twice. */
  remote?: AttachmentMeta;
}

// --- classifying -------------------------------------------------------------

const EXTENSION_KINDS: Record<string, AttachmentKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  heic: "image",
  tiff: "image",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  flac: "audio",
  webm: "audio",
  mp4: "video",
  mov: "video",
  mkv: "video",
  avi: "video",
  m4v: "video",
};

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

export function attachmentKindFor(mime: string, name: string): AttachmentKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return EXTENSION_KINDS[extensionOf(name)] ?? "file";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** `m:ss` for voice notes and clip durations. */
export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// --- local pending items ------------------------------------------------------

const PREVIEW_KINDS = new Set<AttachmentKind>(["image", "video"]);

export function createPending(file: File, durationMs?: number): PendingAttachment {
  const mime = file.type || "application/octet-stream";
  const kind = attachmentKindFor(mime, file.name);
  const attachment: PendingAttachment = {
    id: makeId(),
    file,
    name: file.name || defaultName(kind, mime),
    mime,
    kind,
    size: file.size,
    durationMs,
  };
  if (PREVIEW_KINDS.has(kind)) {
    attachment.previewUrl = URL.createObjectURL(file);
  }
  return attachment;
}

function defaultName(kind: AttachmentKind, mime: string): string {
  return `${kind}-${Date.now().toString(36)}${extensionFor(mime)}`;
}

/** Object URL for a sent attachment's thumbnail; undefined for non-visual kinds. */
export function registerPreview(attachmentId: string, attachment: PendingAttachment): void {
  if (attachment.previewUrl) previews.set(attachmentId, attachment.previewUrl);
}

/** A rendered URL for an attachment: the live upload preview or fetched bytes. */
export function previewFor(attachmentId: string): string | undefined {
  return previews.get(attachmentId) ?? fetched.get(attachmentId)?.url;
}

export function releasePreviews(): void {
  for (const url of previews.values()) URL.revokeObjectURL(url);
  previews.clear();
  for (const entry of fetched.values()) URL.revokeObjectURL(entry.url);
  fetched.clear();
  unfetchable.clear();
}

const previews = new Map<string, string>();
/** Bytes fetched over `media.fetch`, keyed by attachment id (immutable, cached). */
const fetched = new Map<string, { url: string; bytes: number }>();
/** Ids that will never fetch again: `media_gone`, `unsupported`, or too large. */
const unfetchable = new Set<string>();

// --- reading / uploading ------------------------------------------------------

/** Base64 (standard alphabet, no prefix) for an arbitrary byte array. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function readBase64(file: File): Promise<string> {
  return encodeBase64(new Uint8Array(await file.arrayBuffer()));
}

/** Upload one attachment; `too_large` and other protocol errors surface as thrown errors. */
export async function uploadAttachment(
  client: Client,
  attachment: PendingAttachment,
): Promise<AttachmentMeta> {
  if (attachment.remote) return attachment.remote;
  if (attachment.size > uploadLimit()) {
    throw new Error(`${attachment.name} is larger than ${formatBytes(uploadLimit())}`);
  }
  const data = await readBase64(attachment.file);
  const params: Record<string, unknown> = {
    name: attachment.name,
    mime: attachment.mime,
    kind: attachment.kind,
    data,
  };
  if (attachment.durationMs) params.duration_ms = Math.round(attachment.durationMs);
  const result = await client.request<AttachmentMeta>("media.upload", params, UPLOAD_TIMEOUT_MS);
  attachment.remote = result;
  return result;
}

// --- fetching stored bytes ----------------------------------------------------

/** Kinds worth fetching for display; plain files have no viewer. */
const FETCHABLE_KINDS = new Set<AttachmentKind>(["image", "audio", "video"]);

/** Reverse of {@link encodeBase64}: standard base64 (no prefix) to bytes. */
export function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Bytes for one attachment that is already in a rendered transcript.
 *
 * Returns a blob URL to display, or null when the gateway predates
 * `media.fetch`, the kind has no viewer, the file is gone, or it exceeds the
 * advertised fetch cap. Failures are remembered, so a reloaded transcript
 * never retries the same id.
 */
export async function fetchAttachmentBytes(
  client: Client,
  sessionId: string,
  attachment: AttachmentMeta,
): Promise<string | null> {
  if (!FETCHABLE_KINDS.has(attachment.kind)) return null;
  const livePreview = previews.get(attachment.attachment_id);
  if (livePreview) return livePreview;
  const already = fetched.get(attachment.attachment_id)?.url;
  if (already) return already;
  if (!fetchEnabled() || unfetchable.has(attachment.attachment_id)) return null;
  if (attachment.size > fetchLimit()) {
    // Too big for one frame: keep the chip instead of stalling the transcript.
    unfetchable.add(attachment.attachment_id);
    return null;
  }
  try {
    const result = await client.request<MediaFetchResult>(
      "media.fetch",
      { session_id: sessionId, attachment_id: attachment.attachment_id },
      FETCH_TIMEOUT_MS,
    );
    const blob = new Blob([decodeBase64(asString(result.data))], {
      type: asString(result.mime, attachment.mime),
    });
    const url = URL.createObjectURL(blob);
    fetched.set(attachment.attachment_id, { url, bytes: blob.size });
    return url;
  } catch {
    // `media_gone`, `unsupported`, a timeout: the chip stays, no retry.
    unfetchable.add(attachment.attachment_id);
    return null;
  }
}

// --- voice notes --------------------------------------------------------------

const RECORDING_MIMES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/webm": ".webm",
  "audio/mp4": ".m4a",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/mpeg": ".mp3",
};

function extensionFor(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  return AUDIO_EXTENSIONS[base] ?? "";
}

export function recordingSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

export interface VoiceNoteRecorder {
  readonly mime: string;
  readonly startedAt: number;
  /** Stop and return the captured note (null when nothing was captured). */
  finish(): Promise<PendingAttachment | null>;
  /** Stop and discard; the microphone track is always released. */
  cancel(): void;
}

function pickRecordingMime(): string {
  for (const candidate of RECORDING_MIMES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return "";
}

export async function startVoiceNote(): Promise<VoiceNoteRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = pickRecordingMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: BlobPart[] = [];
  const startedAt = Date.now();
  const effectiveMime = recorder.mimeType || mime || "audio/webm";
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  recorder.start();

  const release = (): void => {
    for (const track of stream.getTracks()) track.stop();
  };

  return {
    mime: effectiveMime,
    startedAt,
    finish: () =>
      new Promise<PendingAttachment | null>((resolve) => {
        recorder.onstop = () => {
          release();
          if (chunks.length === 0) {
            resolve(null);
            return;
          }
          const blob = new Blob(chunks, { type: effectiveMime });
          if (blob.size === 0) {
            resolve(null);
            return;
          }
          const name = `voice-note-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}${extensionFor(effectiveMime)}`;
          const file = new File([blob], name, { type: effectiveMime });
          resolve(createPending(file, Date.now() - startedAt));
        };
        recorder.stop();
      }),
    cancel: () => {
      recorder.onstop = () => release();
      if (recorder.state !== "inactive") recorder.stop();
      else release();
    },
  };
}

// --- composer intents ---------------------------------------------------------

export function filesFrom(list: FileList | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list).filter((file) => file.size > 0);
}
