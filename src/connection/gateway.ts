// Local-mode gateway helpers, backed by the Rust side. Browser dev returns inert data so
// the Settings view still renders.

import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "./profiles";

export interface GatewayState {
  found: boolean;
  running: boolean;
  port: number | null;
  pid: number | null;
  launchMode: string | null;
  startedAt: string | null;
  logPath: string | null;
  statePath: string;
}

export interface CliOutput {
  ok: boolean;
  output: string;
}

export async function localGatewayStatus(): Promise<GatewayState> {
  if (!isTauri) {
    return {
      found: false,
      running: false,
      port: null,
      pid: null,
      launchMode: null,
      startedAt: null,
      logPath: null,
      statePath: "~/.mason/run/gateway.json",
    };
  }
  return invoke<GatewayState>("local_gateway_status");
}

export async function gatewayCli(action: string): Promise<CliOutput> {
  if (!isTauri) throw new Error("the mason CLI is only available in the desktop app");
  return invoke<CliOutput>("gateway_cli", { action });
}
