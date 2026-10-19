// Settings: connection profiles, device tokens, the local gateway (desktop only), and the
// browser dev backend switch.

import { button, el, type ViewContext, type ViewModule } from "../app";
import type { GatewayState } from "../connection/gateway";
import { isTauri, type ConnectionMode, type Profile } from "../connection/profiles";
import { errorText, formatTimestamp, truncate } from "../format";
import { APP_VERSION, PROTOCOL_VERSION } from "../protocol";

const MODES: ConnectionMode[] = ["local", "ssh", "ip"];

function modeBadge(mode: ConnectionMode): HTMLElement {
  return el("span", `badge mode-${mode}`, mode);
}

function maskToken(token: string): string {
  if (token.length <= 8) return "••••";
  return `••••••${token.slice(-4)}`;
}

export const settingsView: ViewModule = {
  mount(root: HTMLElement, ctx: ViewContext): () => void {
    const view = el("div", "view settings-view");
    const head = el("header", "view-head");
    const titleWrap = el("div", "view-title");
    titleWrap.append(el("h2", undefined, "Settings"));
    titleWrap.append(
      el("span", "subtle", "connections, device tokens, and the local gateway"),
    );
    head.append(titleWrap);

    const scroll = el("div", "settings-scroll");
    view.append(head, scroll);
    root.append(view);

    // --- profiles form -------------------------------------------------------

    let editing: Profile | null = null;
    let formOpen = false;

    const form = el("form", "form hidden");
    const nameField = el("div", "field");
    const nameLabel = el("label", undefined, "Name");
    const nameInput = el("input");
    nameInput.type = "text";
    nameInput.placeholder = "My VPS";
    nameField.append(nameLabel, nameInput);

    const modeField = el("div", "field");
    modeField.append(el("label", undefined, "Mode"));
    const modeSelect = el("select");
    for (const mode of MODES) {
      const option = el("option", undefined, mode);
      option.value = mode;
      modeSelect.append(option);
    }
    modeField.append(modeSelect);

    const sshBlock = el("div", "form-block hidden");
    const sshHostField = el("div", "field");
    sshHostField.append(el("label", undefined, "SSH host (user@host or ssh_config alias)"));
    const sshHostInput = el("input");
    sshHostInput.type = "text";
    sshHostInput.placeholder = "marco@vps";
    sshHostField.append(sshHostInput);
    const sshPortField = el("div", "field");
    sshPortField.append(el("label", undefined, "SSH port (blank = ssh default)"));
    const sshPortInput = el("input");
    sshPortInput.type = "number";
    sshPortInput.min = "1";
    sshPortInput.max = "65535";
    sshPortField.append(sshPortInput);
    const sshRemoteField = el("div", "field");
    sshRemoteField.append(el("label", undefined, "Gateway port on the remote loopback"));
    const sshRemoteInput = el("input");
    sshRemoteInput.type = "number";
    sshRemoteInput.min = "1";
    sshRemoteInput.max = "65535";
    sshRemoteInput.placeholder = "18790";
    sshRemoteField.append(sshRemoteInput);
    sshBlock.append(sshHostField, sshPortField, sshRemoteField);

    const ipBlock = el("div", "form-block hidden");
    const ipNotice = el("p", "notice");
    ipNotice.append(
      "Direct IP mode speaks ",
      el("code", undefined, "wss://"),
      " to the gateway. It is opt-in: the gateway's /health is unauthenticated off-loopback, so plaintext ws:// is refused for non-loopback hosts.",
    );
    const ipField = el("div", "field");
    ipField.append(el("label", undefined, "Endpoint"));
    const ipInput = el("input");
    ipInput.type = "text";
    ipInput.placeholder = "wss://vps.example.com:18790";
    ipField.append(ipInput);
    ipBlock.append(ipNotice, ipField);

    const autoField = el("label", "checkbox-row");
    const autoInput = el("input");
    autoInput.type = "checkbox";
    autoField.append(autoInput, el("span", undefined, "Connect automatically on launch"));

    const formError = el("p", "form-error hidden");

    const buttonRow = el("div", "btn-row");
    const saveBtn = button("Save profile", "btn primary");
    saveBtn.type = "submit";
    const cancelBtn = button("Cancel", "btn ghost");
    const forgetBtn = button("Forget token", "btn danger hidden");
    buttonRow.append(saveBtn, cancelBtn, forgetBtn);

    form.append(
      nameField,
      modeField,
      sshBlock,
      ipBlock,
      autoField,
      formError,
      buttonRow,
    );

    const syncModeBlocks = (): void => {
      const mode = modeSelect.value as ConnectionMode;
      sshBlock.classList.toggle("hidden", mode !== "ssh");
      ipBlock.classList.toggle("hidden", mode !== "ip");
      forgetBtn.classList.toggle("hidden", !(editing && editing.token));
    };

    const openForm = (profile: Profile | null): void => {
      editing = profile;
      formOpen = true;
      const source = profile ?? {
        id: crypto.randomUUID(),
        name: "",
        mode: "local" as ConnectionMode,
      };
      nameInput.value = source.name;
      modeSelect.value = source.mode;
      sshHostInput.value = source.sshHost ?? "";
      sshPortInput.value = source.sshPort ? String(source.sshPort) : "";
      sshRemoteInput.value = source.sshRemotePort ? String(source.sshRemotePort) : "";
      ipInput.value = source.url ?? "";
      autoInput.checked = source.autoConnect ?? false;
      formError.classList.add("hidden");
      form.classList.remove("hidden");
      syncModeBlocks();
      nameInput.focus();
      render();
    };

    const closeForm = (): void => {
      formOpen = false;
      editing = null;
      form.classList.add("hidden");
      render();
    };

    modeSelect.addEventListener("change", syncModeBlocks);

    const numberOrNull = (value: string): number | null => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
    };

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void (async () => {
        const mode = modeSelect.value as ConnectionMode;
        const profile: Profile = {
          id: editing?.id ?? crypto.randomUUID(),
          name: nameInput.value.trim() || mode,
          mode,
          sshHost: mode === "ssh" ? sshHostInput.value.trim() || null : null,
          sshPort: mode === "ssh" ? numberOrNull(sshPortInput.value) : null,
          sshRemotePort: mode === "ssh" ? numberOrNull(sshRemoteInput.value) : null,
          url: mode === "ip" ? ipInput.value.trim() || null : null,
          token: editing?.token ?? null,
          autoConnect: autoInput.checked,
        };
        if (mode === "ssh" && !profile.sshHost) {
          formError.textContent = "SSH mode needs a host.";
          formError.classList.remove("hidden");
          return;
        }
        if (mode === "ip") {
          const url = profile.url ?? "";
          if (!url.startsWith("wss://") && !url.startsWith("ws://")) {
            formError.textContent = "IP mode needs a wss:// URL.";
            formError.classList.remove("hidden");
            return;
          }
        }
        try {
          await ctx.actions.saveProfile(profile);
          closeForm();
        } catch (error) {
          formError.textContent = errorText(error);
          formError.classList.remove("hidden");
        }
      })();
    });

    cancelBtn.onclick = () => {
      closeForm();
    };
    forgetBtn.onclick = () => {
      const target = editing;
      if (!target) return;
      void (async () => {
        try {
          await ctx.actions.forgetToken(target.id);
          ctx.actions.toast(
            "Device token forgotten — the next connect will ask for pairing.",
          );
          closeForm();
        } catch (error) {
          formError.textContent = errorText(error);
          formError.classList.remove("hidden");
        }
      })();
    };

    // --- local gateway panel ---------------------------------------------------

    let gateway: GatewayState | null = null;
    let gatewayOutput = "";
    const gatewayPanel = el("div", "panel");
    const refreshGateway = async (): Promise<void> => {
      if (!isTauri) return;
      try {
        gateway = await ctx.actions.localGatewayStatus();
      } catch (error) {
        gatewayOutput = errorText(error);
      }
      render();
    };
    const runGateway = async (action: string): Promise<void> => {
      try {
        const result = await ctx.actions.gatewayCli(action);
        gatewayOutput = `$ mason gateway ${action}\n${result.output || "(no output)"}`;
      } catch (error) {
        gatewayOutput = errorText(error);
      }
      await refreshGateway();
    };
    const buildGatewayPanel = (): void => {
      gatewayPanel.replaceChildren();
      if (!isTauri) {
        gatewayPanel.append(
          el(
            "p",
            "empty",
            "Running in a browser — the local gateway panel and profile storage live in the desktop app.",
          ),
        );
        return;
      }
      const state = gateway;
      if (!state) {
        gatewayPanel.append(el("p", "empty", "Reading gateway run-state…"));
        return;
      }
      const lines: [string, string][] = [
        ["Run-state file", state.statePath],
        ["Running", state.running ? "yes" : "no"],
        ["Port", state.port ? String(state.port) : "—"],
        ["PID", state.pid ? String(state.pid) : "—"],
        ["Launch mode", state.launchMode ?? "—"],
        ["Started", state.startedAt ? formatTimestamp(state.startedAt) : "—"],
        ["Logs", state.logPath ?? "—"],
      ];
      const list = el("dl", "kv");
      for (const [label, value] of lines) {
        list.append(el("dt", undefined, label));
        list.append(el("dd", undefined, value));
      }
      gatewayPanel.append(list);

      const actionsRow = el("div", "btn-row");
      for (const action of ["start", "restart", "stop", "logs"]) {
        const btn = button(action === "logs" ? "Show logs" : action[0].toUpperCase() + action.slice(1), "btn ghost");
        btn.onclick = () => {
          void runGateway(action);
        };
        actionsRow.append(btn);
      }
      const refreshBtn = button("Refresh", "btn ghost");
      refreshBtn.onclick = () => {
        void refreshGateway();
      };
      actionsRow.append(refreshBtn);
      gatewayPanel.append(actionsRow);

      if (gatewayOutput) {
        gatewayPanel.append(el("pre", "pre", truncate(gatewayOutput, 4000)));
      }
    };

    // --- dev backend section -----------------------------------------------------

    const devPanel = el("div", "panel hidden");
    if (!isTauri) {
      devPanel.classList.remove("hidden");
      const note = el("p", "notice");
      note.append(
        "Browser dev backend: the UI talks straight to ",
        el("code", undefined, "ws://127.0.0.1:<port>"),
        ". Run ",
        el("code", undefined, "npm run mock"),
        " in another terminal.",
      );
      devPanel.append(note);
      const portField = el("div", "field");
      portField.append(el("label", undefined, "Mock gateway port"));
      const portInput = el("input");
      portInput.type = "number";
      portInput.min = "1";
      portInput.max = "65535";
      const devPortValue = numberOrNull(localStorage.getItem("masondesk.dev.port") ?? "");
      portInput.value = String(devPortValue ?? 18790);
      portField.append(portInput);
      const saveDev = button("Save dev port", "btn ghost");
      saveDev.onclick = () => {
        ctx.actions.setDevPort(numberOrNull(portInput.value) ?? 18790);
      };
      devPanel.append(portField, saveDev);
    }

    // --- render -------------------------------------------------------------------

    const render = (): void => {
      const state = ctx.store.get();
      scroll.replaceChildren();

      const profilesSection = el("section", "section");
      profilesSection.append(el("h3", undefined, "Connection profiles"));
      profilesSection.append(
        el(
          "p",
          "subtle",
          isTauri
            ? "Stored in the app config directory. Tokens are revocable device tokens — never passwords."
            : "Profile editing is available in the desktop app; the browser dev backend uses a single synthetic profile.",
        ),
      );
      const profileList = el("div", "list");
      for (const profile of state.profiles.profiles) {
        const row = el("div", "list-row profile-row");
        const main = el("div", "list-row-main");
        const topLine = el("div", "profile-line");
        topLine.append(el("span", "list-title", profile.name), modeBadge(profile.mode));
        if (profile.id === state.profiles.activeId) {
          topLine.append(el("span", "badge ok", "active"));
        }
        if (profile.token) {
          topLine.append(el("span", "badge muted", maskToken(profile.token)));
        }
        main.append(topLine);
        const detail = describeProfile(profile);
        if (detail) main.append(el("span", "subtle", detail));
        row.append(main);
        const rowActions = el("div", "btn-row");
        if (isTauri) {
          if (profile.id !== state.profiles.activeId) {
            const useBtn = button("Use", "btn ghost");
            useBtn.onclick = () => {
              void ctx.actions.setActiveProfile(profile.id);
            };
            rowActions.append(useBtn);
          }
          const editBtn = button("Edit", "btn ghost");
          editBtn.onclick = () => {
            openForm(profile);
          };
          const deleteBtn = button("Delete", "btn danger");
          deleteBtn.onclick = () => {
            void (async () => {
              await ctx.actions.deleteProfile(profile.id);
              if (editing?.id === profile.id) closeForm();
            })();
          };
          rowActions.append(editBtn, deleteBtn);
        }
        row.append(rowActions);
        profileList.append(row);
      }
      if (state.profiles.profiles.length === 0) {
        profileList.append(el("p", "empty", "No profiles yet."));
      }
      profilesSection.append(profileList);

      if (isTauri) {
        const addBtn = button("Add profile", "btn primary");
        addBtn.onclick = () => {
          openForm(null);
        };
        profilesSection.append(addBtn);
      }
      if (formOpen) profilesSection.append(form);
      scroll.append(profilesSection);

      const gatewaySection = el("section", "section");
      gatewaySection.append(el("h3", undefined, "Local gateway"));
      buildGatewayPanel();
      gatewaySection.append(gatewayPanel);
      scroll.append(gatewaySection);

      if (!isTauri) {
        const devSection = el("section", "section");
        devSection.append(el("h3", undefined, "Browser dev backend"));
        devSection.append(devPanel);
        scroll.append(devSection);
      }

      const aboutSection = el("section", "section");
      aboutSection.append(el("h3", undefined, "About"));
      const aboutList = el("dl", "kv");
      aboutList.append(el("dt", undefined, "MasonDesk"), el("dd", undefined, APP_VERSION));
      aboutList.append(
        el("dt", undefined, "Protocol"),
        el("dd", undefined, `v${PROTOCOL_VERSION} (docs/protocol.md)`),
      );
      aboutList.append(
        el("dt", undefined, "Licence"),
        el("dd", undefined, "AGPL-3.0-or-later (see LICENSE)"),
      );
      aboutSection.append(aboutList);
      scroll.append(aboutSection);
    };

    const describeProfile = (profile: Profile): string => {
      if (profile.mode === "ssh") {
        const port = profile.sshPort ? ` port ${profile.sshPort}` : "";
        const remote = profile.sshRemotePort ? ` → remote ${profile.sshRemotePort}` : "";
        return `${profile.sshHost ?? "no host"}${port}${remote}`;
      }
      if (profile.mode === "ip") return profile.url ?? "no endpoint";
      return "reads ~/.mason/run/gateway.json";
    };

    const unsubscribe = ctx.store.subscribe(render);
    render();
    void refreshGateway();

    return () => {
      unsubscribe();
    };
  },
};
