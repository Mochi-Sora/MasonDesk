// Shared app types and DOM helpers. Views are plain modules: `mount(root, ctx)` returns
// a cleanup function.

import type { Client } from "./connection/client";
import type { GatewayState } from "./connection/gateway";
import type { Profile } from "./connection/profiles";
import type { SteerOutcome } from "./chat";
import type { PendingAttachment } from "./media";
import type { Store } from "./store";

export interface Actions {
  connect(profileId?: string): Promise<void>;
  disconnect(): Promise<void>;
  sendChat(text: string, attachments?: PendingAttachment[]): Promise<void>;
  /** Queue text for the active session; it is sent when its turn ends. */
  queueMessage(text: string): boolean;
  unqueue(id: string): void;
  /** Send into the running turn when the gateway supports it. */
  steer(text: string): Promise<SteerOutcome>;
  interrupt(): Promise<void>;
  newSession(): void;
  openSession(sessionId: string | null): Promise<void>;
  refreshSessions(): Promise<void>;
  refreshCron(): Promise<void>;
  refreshMemory(): Promise<void>;
  approve(approvalId: string): Promise<void>;
  deny(approvalId: string): Promise<void>;
  saveProfile(profile: Profile): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  setActiveProfile(id: string | null): Promise<void>;
  forgetToken(profileId: string): Promise<void>;
  localGatewayStatus(): Promise<GatewayState>;
  gatewayCli(action: string): Promise<{ ok: boolean; output: string }>;
  setDevPort(port: number): void;
  navigate(route: string): void;
  toast(message: string, kind?: "info" | "error"): void;
}

export interface ViewContext {
  store: Store;
  client: Client;
  actions: Actions;
}

export interface ViewModule {
  mount(root: HTMLElement, ctx: ViewContext): () => void;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, className = "btn"): HTMLButtonElement {
  const node = el("button", className, label);
  node.type = "button";
  return node;
}

export function clear(root: HTMLElement): void {
  root.replaceChildren();
}
