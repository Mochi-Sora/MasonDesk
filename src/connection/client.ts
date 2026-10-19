// The protocol client: one implementation of docs/protocol.md with two backends.
//
//  * Desktop (Tauri): Rust owns the socket `/ tunnel / reconnect loop; frames cross the
//    IPC boundary via the `masondesk://frame` and `masondesk://status` events, outgoing
//    frames go through the `send` command.
//  * Browser (dev): a direct WebSocket with the same frame handling, used with
//    `npm run mock` so the UI can be developed without Rust or the framework.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  APP_VERSION,
  isEvent,
  isResponse,
  makeRequest,
  type EventFrame,
  type HelloResult,
  type RequestFrame,
  type RequestType,
} from "../protocol";
import { devPort, isTauri, setDeviceToken, type Profile } from "./profiles";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "unauthorized";

export interface StatusPayload {
  state: ConnectionState;
  mode?: string | null;
  detail?: string | null;
  attempt?: number;
  profileId?: string | null;
}

export interface PairingState {
  code: string;
  expiresAt: number;
  reason: string | null;
}

export class ProtocolRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolRequestError";
    this.code = code;
  }
}

type Handler<T> = (value: T) => void;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function addTo<T>(set: Set<Handler<T>>, handler: Handler<T>): () => void {
  set.add(handler);
  return () => {
    set.delete(handler);
  };
}

function platformName(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform ?? nav.platform ?? "web";
}

export class Client {
  private readonly statusHandlers = new Set<Handler<StatusPayload>>();
  private readonly eventHandlers = new Set<Handler<EventFrame>>();
  private readonly helloHandlers = new Set<Handler<HelloResult>>();
  private readonly pairingHandlers = new Set<Handler<PairingState | null>>();
  private readonly pending = new Map<string, Pending>();

  private profile: Profile | null = null;
  private token: string | null = null;
  private bridge: Promise<void> | null = null;
  private helloInFlight = false;

  // Browser-dev backend only.
  private socket: WebSocket | null = null;
  private manualClose = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;

  onStatus(handler: Handler<StatusPayload>): () => void {
    return addTo(this.statusHandlers, handler);
  }

  onEvent(handler: Handler<EventFrame>): () => void {
    return addTo(this.eventHandlers, handler);
  }

  onHello(handler: Handler<HelloResult>): () => void {
    return addTo(this.helloHandlers, handler);
  }

  onPairing(handler: Handler<PairingState | null>): () => void {
    return addTo(this.pairingHandlers, handler);
  }

  async connect(profile: Profile): Promise<void> {
    this.profile = profile;
    this.token = profile.token ?? null;
    this.manualClose = false;
    this.emitPairing(null);
    if (isTauri) {
      await this.ensureBridge();
      await invoke("connect", { profileId: profile.id });
    } else {
      this.openBrowserSocket();
    }
  }

  /** Adopt a profile's token without starting a connection (used when Rust auto-connects). */
  adopt(profile: Profile): void {
    this.profile = profile;
    this.token = profile.token ?? null;
  }

  /** Install the Tauri-side event bridge eagerly (so auto-connect status arrives). */
  async attach(): Promise<void> {
    if (isTauri) await this.ensureBridge();
  }

  async disconnect(): Promise<void> {
    this.manualClose = true;
    this.clearRetry();
    if (isTauri) {
      await invoke("disconnect");
    } else {
      this.socket?.close(1000, "client disconnect");
      this.socket = null;
      this.emitStatus({ state: "disconnected" });
    }
    this.rejectAll("disconnected");
  }

  /** Current status as known by the Rust side (used on startup). */
  async currentStatus(): Promise<StatusPayload | null> {
    if (!isTauri) return null;
    return invoke<StatusPayload | null>("connection_status");
  }

  /** Send a request frame and resolve with its response result. */
  request<T = unknown>(
    type: RequestType,
    params: Record<string, unknown> = {},
    timeoutMs = 20_000,
  ): Promise<T> {
    const frame = makeRequest(type, params);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(frame.id);
        reject(new Error(`${type} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(frame.id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });
      this.writeFrame(frame).catch((error: unknown) => {
        clearTimeout(timer);
        this.pending.delete(frame.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /** Look up a profile token without importing the profile store everywhere. */
  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  // --- internals ----------------------------------------------------------

  private async ensureBridge(): Promise<void> {
    this.bridge ??= (async () => {
      await listen<StatusPayload>("masondesk://status", (event) => {
        this.emitStatus(event.payload);
        if (event.payload.state === "connected") {
          void this.sendHello();
        }
      });
      await listen<EventFrame>("masondesk://frame", (event) => {
        this.handleFrame(event.payload);
      });
    })();
    await this.bridge;
  }

  private async writeFrame(frame: RequestFrame): Promise<void> {
    if (isTauri) {
      await invoke("send", { frame: JSON.stringify(frame) });
      return;
    }
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
      return;
    }
    throw new Error("not connected");
  }

  private async sendHello(): Promise<void> {
    if (this.helloInFlight) return;
    this.helloInFlight = true;
    try {
      const result = await this.request<HelloResult>(
        "hello",
        {
          device_token: this.token,
          client: { name: "MasonDesk", version: APP_VERSION, platform: platformName() },
        },
        15_000,
      );
      if (result.paired) {
        this.emitPairing(null);
        if (result.device_token && result.device_token !== this.token) {
          this.token = result.device_token;
          await this.persistToken(result.device_token);
        }
      } else if (result.pairing) {
        this.emitPairing({
          code: result.pairing.code,
          expiresAt: result.pairing.expires_at,
          reason: result.reason ?? null,
        });
      }
      for (const handler of this.helloHandlers) handler(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitStatus({ state: "error", detail: message });
    } finally {
      this.helloInFlight = false;
    }
  }

  private handleFrame(value: unknown): void {
    if (isResponse(value)) {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      if (value.ok) {
        pending.resolve(value.result ?? {});
      } else {
        pending.reject(
          new ProtocolRequestError(
            value.error?.code ?? "internal",
            value.error?.message ?? "request failed",
          ),
        );
      }
      return;
    }
    if (!isEvent(value)) return;

    if (value.type === "pairing.approved") {
      const token = typeof value.event.device_token === "string" ? value.event.device_token : null;
      if (token) {
        this.token = token;
        void this.persistToken(token).then(() => this.sendHello());
      }
      return;
    }
    if (value.type === "pairing.denied") {
      this.emitPairing(null);
      return;
    }

    for (const handler of this.eventHandlers) handler(value);
  }

  private async persistToken(token: string | null): Promise<void> {
    if (!this.profile) return;
    try {
      await setDeviceToken(this.profile.id, token);
    } catch (error) {
      console.warn("masondesk: failed to persist the device token", error);
    }
  }

  private emitStatus(status: StatusPayload): void {
    for (const handler of this.statusHandlers) handler(status);
  }

  private emitPairing(pairing: PairingState | null): void {
    for (const handler of this.pairingHandlers) handler(pairing);
  }

  private rejectAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  // --- browser-dev backend --------------------------------------------------

  private openBrowserSocket(): void {
    const port = devPort();
    this.emitStatus({
      state: this.retryAttempt > 0 ? "reconnecting" : "connecting",
      mode: "local",
      attempt: this.retryAttempt,
    });
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    this.socket = socket;
    socket.onopen = () => {
      this.retryAttempt = 0;
      this.emitStatus({ state: "connected", mode: "local", attempt: 0 });
      void this.sendHello();
    };
    socket.onmessage = (message) => {
      if (typeof message.data !== "string") return;
      try {
        this.handleFrame(JSON.parse(message.data));
      } catch {
        // Ignore non-JSON frames, mirroring the Rust side.
      }
    };
    socket.onclose = (event) => {
      this.socket = null;
      if (this.manualClose) {
        this.emitStatus({ state: "disconnected" });
        return;
      }
      if (event.code === 4401) {
        this.emitStatus({
          state: "unauthorized",
          detail: "device token was revoked — pair again",
        });
        return;
      }
      if (event.code === 4400) {
        this.emitStatus({ state: "error", detail: "protocol version mismatch" });
        return;
      }
      this.retryAttempt += 1;
      this.emitStatus({
        state: "reconnecting",
        mode: "local",
        attempt: this.retryAttempt,
        detail: "connection lost",
      });
      const delay = Math.min(30_000, 1000 * 2 ** (this.retryAttempt - 1)) + Math.random() * 500;
      this.retryTimer = setTimeout(() => this.openBrowserSocket(), delay);
    };
    socket.onerror = () => {
      // onclose follows.
    };
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
