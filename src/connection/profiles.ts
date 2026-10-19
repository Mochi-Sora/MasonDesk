// Connection profiles. In the desktop app these live in Rust (`src-tauri/src/config.rs`);
// when the UI runs in a plain browser (`npm run dev` against dev/mock-gateway.mjs) a single
// synthetic profile backed by localStorage is used instead.

import { invoke } from "@tauri-apps/api/core";

export type ConnectionMode = "local" | "ssh" | "ip";

export interface Profile {
  id: string;
  name: string;
  mode: ConnectionMode;
  sshHost?: string | null;
  sshPort?: number | null;
  sshRemotePort?: number | null;
  url?: string | null;
  token?: string | null;
  autoConnect?: boolean | null;
}

export interface ProfilesState {
  profiles: Profile[];
  activeId: string | null;
}

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const DEV_PROFILE_ID = "dev-local";
const DEV_PORT_KEY = "masondesk.dev.port";
const DEV_TOKEN_KEY = "masondesk.dev.token";

export function devPort(): number {
  const raw = Number(localStorage.getItem(DEV_PORT_KEY) ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 18790;
}

export function setDevPort(port: number): void {
  localStorage.setItem(DEV_PORT_KEY, String(port));
}

export function devToken(): string | null {
  return localStorage.getItem(DEV_TOKEN_KEY);
}

export function setDevToken(token: string | null): void {
  if (token === null) {
    localStorage.removeItem(DEV_TOKEN_KEY);
  } else {
    localStorage.setItem(DEV_TOKEN_KEY, token);
  }
}

export function devProfile(): Profile {
  return {
    id: DEV_PROFILE_ID,
    name: "Local dev gateway",
    mode: "local",
    token: devToken(),
  };
}

function devState(): ProfilesState {
  return { profiles: [devProfile()], activeId: DEV_PROFILE_ID };
}

export async function listProfiles(): Promise<ProfilesState> {
  if (!isTauri) return devState();
  return invoke<ProfilesState>("list_profiles");
}

export async function upsertProfile(profile: Profile): Promise<ProfilesState> {
  if (!isTauri) throw new Error("profiles are read-only outside the desktop app");
  return invoke<ProfilesState>("upsert_profile", { profile });
}

export async function deleteProfile(id: string): Promise<ProfilesState> {
  if (!isTauri) throw new Error("profiles are read-only outside the desktop app");
  return invoke<ProfilesState>("delete_profile", { id });
}

export async function setActiveProfile(id: string | null): Promise<ProfilesState> {
  if (!isTauri) return devState();
  return invoke<ProfilesState>("set_active_profile", { id });
}

export async function setDeviceToken(
  profileId: string,
  token: string | null,
): Promise<ProfilesState> {
  if (!isTauri) {
    setDevToken(token);
    return devState();
  }
  return invoke<ProfilesState>("set_device_token", { profileId, token });
}
