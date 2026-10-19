// App shell: sidebar, top bar (profile picker, status, connect), hash router, and all
// event wiring between the protocol client, the chat controller, and the store.

import { button, el, type Actions, type ViewContext } from "./app";
import { ChatController } from "./chat";
import { Client } from "./connection/client";
import {
  deleteProfile as deleteProfileRequest,
  isTauri,
  listProfiles,
  setActiveProfile as setActiveProfileRequest,
  setDeviceToken as setDeviceTokenRequest,
  setDevPort as setDevPortRequest,
  upsertProfile as upsertProfileRequest,
  type Profile,
} from "./connection/profiles";
import { errorText, truncate } from "./format";
import { gatewayCli, localGatewayStatus } from "./connection/gateway";
import { adoptGatewayLimits } from "./media";
import {
  payload,
  type ApprovalPayload,
  type CronListResult,
  type MemoryStats,
  type SessionUpdatedPayload,
  type SessionsListResult,
} from "./protocol";
import { createStore, type AppState } from "./store";
import { chatView } from "./views/chat";
import { cronView } from "./views/cron";
import { memoriesView } from "./views/memories";
import { sessionsView } from "./views/sessions";
import { settingsView } from "./views/settings";

const initialState: AppState = {
  profiles: { profiles: [], activeId: null },
  status: { state: "disconnected", mode: null, detail: null, attempt: 0, profileId: null },
  paired: false,
  pairing: null,
  features: [],
  sessions: [],
  activeSessionId: null,
  chatBusy: false,
  messages: [],
  queued: [],
  approvals: [],
  cron: [],
  memory: null,
  lastError: null,
  devMode: !isTauri,
};

const store = createStore(initialState);
const client = new Client();
const chat = new ChatController(client, store, (message, kind) => toast(message, kind));

// --- shell -------------------------------------------------------------------

const app = document.getElementById("app");
if (!app) throw new Error("#app is missing from index.html");
app.replaceChildren();

const sidebar = el("aside", "sidebar");
const brand = el("div", "brand");
brand.append(el("span", "brand-mark", "M"), el("span", "brand-name", "MasonDesk"));
const nav = el("nav", "nav");

const routes = [
  { id: "chat", label: "Chat", view: chatView },
  { id: "sessions", label: "Sessions", view: sessionsView },
  { id: "cron", label: "Cron", view: cronView },
  { id: "memories", label: "Memories", view: memoriesView },
  { id: "settings", label: "Settings", view: settingsView },
];
const navButtons = new Map<string, HTMLButtonElement>();
for (const route of routes) {
  const navButton = el("button", "nav-item", route.label);
  navButton.type = "button";
  navButton.onclick = () => navigate(route.id);
  nav.append(navButton);
  navButtons.set(route.id, navButton);
}
const sidebarFoot = el("div", "sidebar-foot");
sidebar.append(brand, nav, sidebarFoot);

const main = el("div", "main");
const topbar = el("header", "topbar");
const profileSelect = el("select", "select");
const statusChip = el("span", "status-chip");
const connectBtn = button("Connect", "btn primary");
topbar.append(profileSelect, statusChip, connectBtn);
const viewHost = el("div", "view-host");
main.append(topbar, viewHost);

const toasts = el("div", "toasts");
app.append(sidebar, main, toasts);

const toast = (message: string, kind: "info" | "error" = "info"): void => {
  const node = el("div", `toast${kind === "error" ? " error" : ""}`, message);
  toasts.append(node);
  setTimeout(() => {
    node.remove();
  }, 7000);
};

// --- router ------------------------------------------------------------------

let current: { id: string; cleanup: () => void } | null = null;

const renderRoute = (): void => {
  const requested = location.hash.replace(/^#\//, "") || "chat";
  const route = routes.find((candidate) => candidate.id === requested) ?? routes[0];
  if (current?.id === route.id) return;
  current?.cleanup();
  viewHost.replaceChildren();
  const cleanup = route.view.mount(viewHost, ctx);
  current = { id: route.id, cleanup };
  for (const [id, navButton] of navButtons) {
    navButton.classList.toggle("active", id === route.id);
  }
};

const navigate = (route: string): void => {
  const target = `#/${route}`;
  if (location.hash === target) {
    renderRoute();
  } else {
    location.hash = target;
  }
};

window.addEventListener("hashchange", renderRoute);

// --- actions -----------------------------------------------------------------

const actions: Actions = {
  async connect(profileId) {
    const state = store.get();
    const id = profileId ?? state.profiles.activeId;
    const profile = state.profiles.profiles.find((candidate) => candidate.id === id);
    if (!profile) {
      toast("no profile selected", "error");
      return;
    }
    try {
      await client.connect(profile);
    } catch (error) {
      toast(`connect failed: ${errorText(error)}`, "error");
    }
  },
  async disconnect() {
    await client.disconnect();
  },
  async sendChat(text, attachments) {
    await chat.send(text, attachments ?? []);
  },
  queueMessage(text) {
    // The queued chip above the composer is the feedback; no toast.
    return chat.queueMessage(text);
  },
  unqueue(id) {
    chat.unqueue(id);
  },
  async steer(text) {
    return chat.steer(text);
  },
  async interrupt() {
    await chat.interrupt();
  },
  newSession() {
    chat.reset(null);
  },
  async openSession(sessionId) {
    await chat.openSession(sessionId);
  },
  async refreshSessions() {
    const state = store.get();
    if (state.status.state !== "connected" || !state.paired) return;
    try {
      const result = await client.request<SessionsListResult>("sessions.list", { limit: 50 });
      store.set({ sessions: result.sessions ?? [] });
    } catch (error) {
      toast(`sessions: ${errorText(error)}`, "error");
    }
  },
  async refreshCron() {
    const state = store.get();
    if (state.status.state !== "connected" || !state.paired) return;
    try {
      const result = await client.request<CronListResult>("cron.list");
      store.set({ cron: result.jobs ?? [] });
    } catch (error) {
      toast(`cron: ${errorText(error)}`, "error");
    }
  },
  async refreshMemory() {
    const state = store.get();
    if (state.status.state !== "connected" || !state.paired) return;
    try {
      const memory = await client.request<MemoryStats>("memory.stats");
      store.set({ memory });
    } catch (error) {
      toast(`memory: ${errorText(error)}`, "error");
    }
  },
  async approve(approvalId) {
    try {
      await client.request("approve", { approval_id: approvalId });
    } catch (error) {
      toast(`approve failed: ${errorText(error)}`, "error");
    }
    store.set({ approvals: store.get().approvals.filter((a) => a.approvalId !== approvalId) });
  },
  async deny(approvalId) {
    try {
      await client.request("deny", { approval_id: approvalId });
    } catch (error) {
      toast(`deny failed: ${errorText(error)}`, "error");
    }
    store.set({ approvals: store.get().approvals.filter((a) => a.approvalId !== approvalId) });
  },
  async saveProfile(profile: Profile) {
    const profiles = await upsertProfileRequest(profile);
    store.set({ profiles });
    toast(`profile "${profile.name}" saved`);
  },
  async deleteProfile(id) {
    const profiles = await deleteProfileRequest(id);
    store.set({ profiles });
  },
  async setActiveProfile(id) {
    const profiles = await setActiveProfileRequest(id);
    store.set({ profiles });
  },
  async forgetToken(profileId) {
    const profiles = await setDeviceTokenRequest(profileId, null);
    store.set({ profiles });
    client.setToken(null);
  },
  localGatewayStatus: async () => localGatewayStatus(),
  gatewayCli: async (action) => gatewayCli(action),
  setDevPort(port) {
    setDevPortRequest(port);
    toast(`dev port set to ${port}`);
  },
  navigate,
  toast,
};

const ctx: ViewContext = { store, client, actions };

// --- chrome ------------------------------------------------------------------

let profilesSignature = "";

const statusLabel = (state: AppState): string => {
  const mode = state.status.mode ? ` · ${state.status.mode}` : "";
  switch (state.status.state) {
    case "connected":
      return `Connected${mode}`;
    case "connecting":
      return `Connecting${mode}…`;
    case "reconnecting":
      return `Reconnecting${mode}${
        state.status.attempt ? ` (attempt ${state.status.attempt})` : ""
      }…`;
    case "error":
      return state.status.detail
        ? `Error: ${truncate(state.status.detail, 90)}`
        : "Error";
    case "unauthorized":
      return "Unauthorized — pair again";
    default:
      return "Disconnected";
  }
};

const renderChrome = (): void => {
  const state = store.get();
  const signature =
    state.profiles.profiles.map((profile) => `${profile.id}:${profile.name}`).join("|") +
    `#${state.profiles.activeId ?? ""}`;
  if (signature !== profilesSignature) {
    profilesSignature = signature;
    profileSelect.replaceChildren();
    for (const profile of state.profiles.profiles) {
      const option = el("option", undefined, profile.name);
      option.value = profile.id;
      profileSelect.append(option);
    }
    profileSelect.value = state.profiles.activeId ?? "";
  }
  statusChip.className = `status-chip ${state.status.state}`;
  statusChip.textContent = statusLabel(state);
  statusChip.title = state.status.detail ?? "";
  const live = ["connected", "connecting", "reconnecting"].includes(state.status.state);
  connectBtn.textContent = live ? "Disconnect" : "Connect";
  sidebarFoot.replaceChildren();
  sidebarFoot.append(el("span", undefined, `protocol v1 · app ${initialState.devMode ? "dev" : "desktop"}`));
  if (state.paired) sidebarFoot.append(el("span", "badge ok", "paired"));
};

profileSelect.addEventListener("change", () => {
  const id = profileSelect.value || null;
  void actions.setActiveProfile(id).catch((error: unknown) => {
    toast(errorText(error), "error");
  });
});

connectBtn.addEventListener("click", () => {
  const state = store.get();
  const live = ["connected", "connecting", "reconnecting"].includes(state.status.state);
  if (live) {
    void actions.disconnect();
  } else {
    void actions.connect();
  }
});

// --- protocol wiring -----------------------------------------------------------

client.onStatus((status) => {
  store.set({ status });
  if (status.state === "disconnected") store.set({ paired: false });
  if (status.state === "unauthorized") {
    toast("device token revoked — pair this device again", "error");
  }
  if (status.state === "error" && status.detail) {
    toast(status.detail, "error");
  }
});

client.onPairing((pairing) => {
  store.set({ pairing });
});

client.onHello((result) => {
  adoptGatewayLimits(result.limits);
  store.set({ paired: result.paired, features: result.features ?? [] });
  if (result.paired) {
    toast("MasonDesk is paired");
    void actions.refreshSessions();
  }
});

client.onEvent((frame) => {
  chat.handle(frame);
  switch (frame.type) {
    case "approval": {
      const approval = payload<ApprovalPayload>(frame.event);
      store.set({
        approvals: [
          ...store.get().approvals,
          {
            approvalId: approval.approval_id,
            sessionId: approval.session_id,
            turnId: approval.turn_id,
            tool: approval.tool,
            summary: approval.summary,
            argsPreview: approval.args_preview,
          },
        ],
      });
      break;
    }
    case "session.updated": {
      const update = payload<SessionUpdatedPayload>(frame.event);
      const sessions = store.get().sessions.map((session) =>
        session.id === update.session_id
          ? {
              ...session,
              title: update.title ?? session.title,
              updated_at: update.updated_at,
              message_count: update.message_count ?? session.message_count,
            }
          : session,
      );
      store.set({ sessions });
      break;
    }
    default:
      break;
  }
});

// Keepalive: two unanswered pings mean the connection is dead (docs/protocol.md §3).
setInterval(() => {
  if (store.get().status.state !== "connected") return;
  void client.request("ping", { ts: Date.now() }, 10_000).catch(() => undefined);
}, 30_000);

// --- init -----------------------------------------------------------------------

const init = async (): Promise<void> => {
  try {
    const profiles = await listProfiles();
    store.set({ profiles });
  } catch (error) {
    toast(`failed to load profiles: ${errorText(error)}`, "error");
  }

  if (isTauri) {
    await client.attach();
    const state = store.get();
    const active =
      state.profiles.profiles.find((profile) => profile.id === state.profiles.activeId) ??
      state.profiles.profiles[0];
    if (active) client.adopt(active);
    try {
      const status = await client.currentStatus();
      if (status) store.set({ status });
    } catch {
      // The status event stream will update us once a connection starts.
    }
  }
};

store.subscribe(renderChrome);
renderChrome();
renderRoute();
if (!location.hash) location.hash = "#/chat";
void init();
