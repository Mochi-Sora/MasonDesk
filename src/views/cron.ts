import { button, el, type ViewContext, type ViewModule } from "../app";
import { timeAgo } from "../format";

export const cronView: ViewModule = {
  mount(root: HTMLElement, ctx: ViewContext): () => void {
    const view = el("div", "view");

    const head = el("header", "view-head");
    const titleWrap = el("div", "view-title");
    titleWrap.append(el("h2", undefined, "Cron"));
    titleWrap.append(el("span", "subtle", "scheduled jobs on the gateway"));
    const refreshBtn = button("Refresh", "btn ghost");
    head.append(titleWrap, refreshBtn);

    const body = el("div", "panel");
    view.append(head, body);
    root.append(view);

    const render = (): void => {
      const state = ctx.store.get();
      body.replaceChildren();
      if (state.status.state !== "connected") {
        body.append(el("p", "empty", "Connect to a gateway to list cron jobs."));
        return;
      }
      if (state.cron.length === 0) {
        body.append(el("p", "empty", "No cron jobs are configured."));
        return;
      }
      const table = el("table", "table");
      const thead = el("thead");
      const headRow = el("tr");
      for (const label of ["Job", "Schedule", "Next run", "Last run", "Status"]) {
        headRow.append(el("th", undefined, label));
      }
      thead.append(headRow);
      const tbody = el("tbody");
      for (const job of state.cron) {
        const row = el("tr");
        if (!job.enabled) row.classList.add("disabled");

        const nameCell = el("td");
        nameCell.append(el("span", "list-title", job.name || job.id));
        if (job.payload_preview) {
          nameCell.append(el("span", "subtle", job.payload_preview));
        }
        row.append(nameCell);

        const scheduleCell = el("td");
        scheduleCell.append(el("code", undefined, job.schedule));
        row.append(scheduleCell);

        row.append(el("td", "subtle", timeAgo(job.next_run_at)));
        row.append(el("td", "subtle", job.last_run_at ? timeAgo(job.last_run_at) : "never"));

        const statusCell = el("td");
        const status = job.last_status ?? "—";
        statusCell.append(
          el("span", `badge ${status === "ok" ? "ok" : status === "error" ? "err" : ""}`, status),
        );
        if (!job.enabled) statusCell.append(el("span", "badge muted", "disabled"));
        row.append(statusCell);

        tbody.append(row);
      }
      table.append(thead, tbody);
      body.append(table);
      body.append(
        el("p", "subtle footnote", "Times are shown for this machine; schedules run on the gateway."),
      );
    };

    refreshBtn.onclick = () => {
      void ctx.actions.refreshCron();
    };

    const unsubscribe = ctx.store.subscribe(render);
    render();
    void ctx.actions.refreshCron();

    return () => {
      unsubscribe();
    };
  },
};
