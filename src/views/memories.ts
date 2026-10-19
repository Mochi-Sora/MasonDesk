// The memories screen renders the gateway's `memory.stats` frame — the same payload as
// the `/health` `memory` block (docs/protocol.md §5).

import { button, el, type ViewContext, type ViewModule } from "../app";
import { formatBytes, formatTimestamp, timeAgo } from "../format";

function card(label: string, value: string, hint?: string): HTMLElement {
  const node = el("div", "card");
  node.append(el("span", "card-label", label));
  node.append(el("span", "card-value", value));
  if (hint) node.append(el("span", "card-hint", hint));
  return node;
}

export const memoriesView: ViewModule = {
  mount(root: HTMLElement, ctx: ViewContext): () => void {
    const view = el("div", "view");

    const head = el("header", "view-head");
    const titleWrap = el("div", "view-title");
    titleWrap.append(el("h2", undefined, "Memories"));
    titleWrap.append(el("span", "subtle", "gateway memory health (the /health payload)"));
    const refreshBtn = button("Refresh", "btn ghost");
    head.append(titleWrap, refreshBtn);

    const body = el("div", "memories-body");
    view.append(head, body);
    root.append(view);

    const render = (): void => {
      const state = ctx.store.get();
      body.replaceChildren();
      if (state.status.state !== "connected") {
        body.append(el("p", "empty", "Connect to a gateway to read memory stats."));
        return;
      }
      const memory = state.memory;
      if (!memory) {
        body.append(el("p", "empty", "No memory stats yet — press Refresh."));
        return;
      }

      const summary = el("div", "memories-summary");
      summary.append(
        el(
          "span",
          `badge ${memory.enabled ? "ok" : "muted"}`,
          memory.enabled ? "memory enabled" : "memory disabled",
        ),
      );
      body.append(summary);

      const grid = el("div", "card-grid");
      grid.append(
        card("Episodes", String(memory.episodes ?? "—")),
        card("Memories", String(memory.memories ?? "—")),
        card("Edges", String(memory.edges ?? "—")),
        card(
          "Pending episodes",
          String(memory.pending_episodes ?? "—"),
          memory.pending_episodes > 0 ? "waiting for consolidation" : undefined,
        ),
        card("Memory uses", String(memory.memory_uses_total ?? "—"), "retrievals across all turns"),
        card(
          "Never used",
          String(memory.memories_never_used ?? "—"),
          memory.memories_never_used > 0 ? "stored but never retrieved" : undefined,
        ),
        card(
          "Database",
          formatBytes(memory.db_bytes),
          `${formatBytes(memory.wal_bytes)} WAL`,
        ),
        card(
          "Consolidation cursor",
          String(memory.consolidation_cursor ?? "—"),
          `last ok ${timeAgo(memory.consolidation_last_ok_at)}`,
        ),
      );
      body.append(grid);

      const details = el("div", "card-grid details-grid");
      details.append(
        card(
          "Last consolidation attempt",
          formatTimestamp(memory.consolidation_last_attempt_at),
        ),
        card("Last consolidation ok", formatTimestamp(memory.consolidation_last_ok_at)),
        card(
          "Last consolidation error",
          memory.consolidation_last_error ? "error" : "none",
          memory.consolidation_last_error ?? undefined,
        ),
        card("Last checkpoint", formatTimestamp(memory.last_checkpoint)),
        card("Last snapshot", formatTimestamp(memory.last_snapshot)),
      );
      body.append(details);
    };

    refreshBtn.onclick = () => {
      void ctx.actions.refreshMemory();
    };

    const unsubscribe = ctx.store.subscribe(render);
    render();
    void ctx.actions.refreshMemory();

    return () => {
      unsubscribe();
    };
  },
};
