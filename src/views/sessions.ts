import { button, el, type ViewContext, type ViewModule } from "../app";
import { timeAgo } from "../format";

export const sessionsView: ViewModule = {
  mount(root: HTMLElement, ctx: ViewContext): () => void {
    const view = el("div", "view");

    const head = el("header", "view-head");
    const titleWrap = el("div", "view-title");
    titleWrap.append(el("h2", undefined, "Sessions"));
    titleWrap.append(el("span", "subtle", "conversations stored by the gateway"));
    const refreshBtn = button("Refresh", "btn ghost");
    head.append(titleWrap, refreshBtn);

    const list = el("div", "list sessions-list");
    view.append(head, list);
    root.append(view);

    const render = (): void => {
      const state = ctx.store.get();
      list.replaceChildren();
      if (state.status.state !== "connected") {
        list.append(el("p", "empty", "Connect to a gateway to list sessions."));
        return;
      }
      if (state.sessions.length === 0) {
        list.append(el("p", "empty", "No sessions yet — start one in the Chat view."));
        return;
      }
      for (const session of state.sessions) {
        const row = el("button", "list-row");
        row.type = "button";
        const main = el("div", "list-row-main");
        main.append(el("span", "list-title", session.title || session.id));
        const meta = el(
          "span",
          "subtle",
          `${session.message_count} message${session.message_count === 1 ? "" : "s"} · updated ${timeAgo(session.updated_at)}`,
        );
        main.append(meta);
        row.append(main, el("span", "chevron", "›"));
        if (session.id === state.activeSessionId) row.classList.add("active");
        row.onclick = () => {
          void ctx.actions
            .openSession(session.id)
            .then(() => ctx.actions.navigate("chat"))
            .catch((error: unknown) => ctx.actions.toast(String(error), "error"));
        };
        list.append(row);
      }
    };

    refreshBtn.onclick = () => {
      void ctx.actions.refreshSessions();
    };

    const unsubscribe = ctx.store.subscribe(render);
    render();
    void ctx.actions.refreshSessions();

    return () => {
      unsubscribe();
    };
  },
};
