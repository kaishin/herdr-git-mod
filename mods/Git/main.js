import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextView, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { exec, props, focused, spaces, panes, theme, settings, layout, run, openOverlay, closeOverlay, nextCommand, shared, setShared } from "herdr";
import { GitClient } from "./client.js";
import { layoutLanes } from "./lanes.js";
import { contextKey, ago, tint, refLabel, reviewLabel } from "./model.js";
import { button, segments, bar, label, secondary, pill, empty, graphCell, icon, stop, ROW } from "./ui.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children || []) { const result = find(child, id); if (result) return result; }
  return null;
}
function dockState(dock) {
  if (!dock) return null;
  const panel = find(layout(), dock.panel), stack = find(layout(), dock.stack);
  if (!panel || !stack?.children?.some(n => n.id === dock.child && n.content?.mod === "Git")) return null;
  return { on: !panel.hidden && stack.active === dock.child };
}
function currentLocation(previous) {
  const space = spaces().find(s => s.active), f = focused();
  if (!space) return { cwd: "", on: null, space: null };
  const pane = panes().find(p => p.pane === f?.pane);
  const cwd = pane?.cwd || f?.cwd;
  const on = f?.pane === null && cwd ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space.machine;
  if (cwd) return { cwd, on, space: space.id };
  return previous?.space === space.id ? previous : { cwd: space.folder, on: space.machine, space: space.id };
}
function openGit(dock) {
  const state = dockState(dock);
  if (state) {
    if (state.on) run("layout.hide", { id: dock.panel });
    else { run("layout.select", { stack: dock.stack, child: dock.child }); run("layout.show", { id: dock.panel }); }
  } else {
    const where = currentLocation(null);
    openOverlay({ mod: "Git", kind: "window", key: "git", width: 1100, height: 720, props: { folder: where.cwd, on: where.on } });
  }
}

export default class Git extends View {
  init(_props, cx) {
    const p = props() || {};
    this.toolbar = p.toolbar === true;
    if (this.toolbar) {
      if (p.dock) {
        const panels = shared("workspace.panels") || ["files", "changes"];
        if (!panels.includes(p.dock.child)) setShared("workspace.panels", [...panels, p.dock.child]);
      }
      return;
    }
    this.fixed = Boolean(p.folder);
    this.where = this.fixed ? { cwd: p.folder, on: p.on || null } : currentLocation(null);
    this.width = p.overlay ? 1100 : 368;
    this.height = 720;
    this.mode = "history";
    this.filter = "all";
    this.all = true;
    this.limit = 150;
    this.prLimit = 50;
    this.epoch = 0;
    this.detailEpoch = 0;
    this.prEpoch = 0;
    this.data = null;
    this.prs = null;
    this.selected = null;
    this.detail = null;
    this.error = null;
    this.notice = null;
    this.pending = null;
    this.busy = false;
    this.loading = false;
    this.prLoading = false;
    this.handle = cx.focus_handle();
    this.scroll = { commits: VirtualListScrollHandle.new(), prs: VirtualListScrollHandle.new(), branches: VirtualListScrollHandle.new() };
    this.cursor = null;
    this.listId = `git-list-${Math.random().toString(36).slice(2)}`;
    this.search = InputState.new({ placeholder: "Find a branch" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.enter(this.where, cx);
    cx.timer.every(15000, cx => { if (this.visible() && !this.busy && !this.loading && !this.pending) this.refresh(cx); });
    cx.timer.every(60000, cx => { if (this.visible() && this.mode === "prs" && !this.pending) this.loadPRs(cx); });
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
        if (command === "refresh") this.refresh(cx, true);
        if (["history", "prs", "branches"].includes(command)) this.setMode(command, cx);
        cx.notify();
      }
    });
  }
  visible() { const state = dockState(props()?.dock); return !state || state.on; }
  enter(where, cx) {
    this.epoch++;
    this.prEpoch++;
    this.detailEpoch++;
    this.where = where;
    this.client = new GitClient(exec, where);
    this.data = null;
    this.prs = null;
    this.prLoading = false;
    this.loading = false;
    this.detailLoading = false;
    this.detailError = null;
    this.operationError = null;
    this.error = null;
    this.prError = null;
    this.notice = null;
    this.pending = null;
    this.selected = null;
    this.cursor = null;
    this.detail = null;
    this.limit = 150;
    this.prLimit = 50;
    if (where.cwd) this.refresh(cx, true);
  }
  refresh(cx, prs = false) {
    if (this.busy || this.loading || !this.where.cwd) return;
    const epoch = this.epoch, client = this.client, limit = this.limit, all = this.all;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const data = await client.snapshot(limit, all);
        if (epoch !== this.epoch) return;
        this.data = data;
        this.graph = layoutLanes(data.commits);
        this.error = null;
        this.updated = Date.now();
      } catch (e) { if (epoch === this.epoch) { this.error = e.message; this.pending = null; } }
      finally { if (epoch === this.epoch) { this.loading = false; if (prs && this.mode === "prs") this.loadPRs(cx); cx.notify(); } }
    });
  }
  loadPRs(cx) {
    if (this.busy || this.prLoading || !this.data) return;
    const epoch = ++this.prEpoch, client = this.client, filter = this.filter;
    this.prLoading = true;
    cx.spawn(async cx => {
      try {
        const result = await client.prs(filter, this.prLimit);
        if (epoch !== this.prEpoch) return;
        this.prs = result.rows;
        this.prMore = result.more;
        this.prError = null;
      } catch (e) { if (epoch === this.prEpoch) this.prError = `${e.message}\nThis checkout needs a GitHub remote and an authenticated gh session on ${this.where.on || "this computer"}. Check gh auth status, then retry.`; }
      finally { if (epoch === this.prEpoch) { this.prLoading = false; cx.notify(); } }
    });
  }
  setMode(mode, cx) {
    if (this.busy) return;
    this.mode = mode;
    this.cursor = null;
    this.selected = null;
    this.detail = null;
    this.detailError = null;
    this.detailLoading = false;
    this.detailEpoch++;
    this.pending = null;
    if (mode === "prs" && !this.prs) this.loadPRs(cx);
    if (mode === "branches") this.search.focus();
    cx.notify();
  }
  select(item, kind, cx) {
    this.selected = { item, kind };
    this.detail = null;
    this.detailError = null;
    this.detailLoading = true;
    const epoch = ++this.detailEpoch, client = this.client;
    cx.spawn(async cx => {
      try {
        const detail = kind === "commit" ? await client.commit(item.hash) : await client.pr(item.number);
        if (epoch === this.detailEpoch) this.detail = detail;
      } catch (e) { if (epoch === this.detailEpoch) this.detailError = e.message; }
      finally { if (epoch === this.detailEpoch) { this.detailLoading = false; cx.notify(); } }
    });
    cx.notify();
  }
  ask(action, cx) {
    if (!this.data || this.error || this.busy || this.loading) return;
    const data = this.data;
    if (action.kind === "push") {
      action.remote = data.upstreamRemote || (data.remotes.length === 1 ? data.remotes[0] : data.remotes.includes("origin") ? "origin" : null);
      action.target = data.upstreamRef || `refs/heads/${data.branch}`;
      if (!action.remote) { this.error = "No unambiguous push remote. Configure an upstream in your terminal, then refresh."; cx.notify(); return; }
    }
    this.pending = { action, snapshot: data, client: this.client, where: contextKey(this.where) };
    this.notice = null;
    cx.notify();
  }
  perform(cx) {
    const pending = this.pending;
    if (!pending || this.busy || pending.where !== contextKey(this.where)) return;
    // Bind all async work to the confirmed checkout, not whatever becomes focused later.
    this.busy = true;
    this.error = null;
    this.operationError = null;
    cx.spawn(async cx => {
      try {
        await pending.client.mutate(pending.action, pending.snapshot);
        this.notice = ({ branch: "Branch switched.", pr: "Pull request checked out.", push: "Push completed.", pull: "Pull completed." })[pending.action.kind];
        this.selected = null;
        this.detail = null;
        this.detailEpoch++;
      } catch (e) { this.notice = null; this.error = e.message; }
      finally {
        this.busy = false;
        this.pending = null;
        // Preserve operation errors while rereading the repository.
        const error = this.error;
        this.refresh(cx, true);
        if (error) this.operationError = error;
        cx.notify();
      }
    });
    cx.notify();
  }
  closePanel() {
    if (props()?.overlay) closeOverlay(props().overlay);
    else if (dockState(props()?.dock)) run("layout.hide", { id: props().dock.panel });
  }
  activate(id, item, cx) {
    if (this.busy) return;
    this.handle.focus();
    this.cursor = String(item.ref || item.hash || item.number);
    if (id === "commits") this.select(item, "commit", cx);
    else if (id === "prs") this.select(item, "pr", cx);
    else if ((!item.worktree || item.worktree === this.data.root) && (item.remote || item.name !== this.data.branch)) this.ask({ kind: "branch", branch: item }, cx);
  }
  list(id, rows, height, render) {
    const name = `${this.listId}-${id}`, epoch = this.epoch;
    const key = row => String(row.ref || row.hash || row.number);
    return div().flex_1().min_h(0).min_w(0).relative()
      .child(v_virtual_list(name, rows.length, height, i => key(rows[i]), range => rows.slice(range.start, range.end).map((row, i) => render(row, range.start + i)))
        .track_scroll(this.scroll[id]).size_full()
        .on_item_click((clicked, cx) => {
          const item = rows.find(row => key(row) === clicked);
          if (item && epoch === this.epoch) this.activate(id, item, cx);
        }))
      .child(Scrollbar.vertical(name).viewport_from_layout().absolute().inset_0());
  }
  history() {
    const t = theme(), data = this.data, commits = data?.commits || [];
    const graph = this.graph;
    const graphWidth = Math.max(40, (graph?.width || 1) * 12 + 16);
    // Keep every lane: unusual high-fanout histories scroll horizontally, never fake a straight rail.
    return v_flex().flex_1().min_h(0).min_w(0)
      .child(bar().child(label("Commits")).child(secondary(String(commits.length))).child(div().flex_1())
        .child(button("scope", this.all ? "All branches" : "Current branch", cx => { this.all = !this.all; this.limit = 150; this.refresh(cx); cx.notify(); }, { small: true, enabled: !this.loading && !this.busy })))
      .when(!commits.length, e => e.child(empty(this.loading ? "Reading history…" : data ? "No commits yet" : "Open a checkout", data ? "Your first commit will appear here." : "Git follows the focused terminal’s folder.")))
      .when(commits.length > 0, e => e.child(v_flex().id("history-horizontal").flex_1().min_h(0).min_w(0).overflow_x_scrollbar()
        .child(this.list("commits", commits, ROW, (commit, i) => {
          const selected = this.selected?.item?.hash === commit.hash;
          const refs = commit.refs.map(refLabel);
          return div().id(`commit-${commit.hash}`).flex().items_center().h(ROW).w_full().px(8).bg(selected ? t.selected : "#00000000").text_color(t.foreground)
            .hover(s => s.bg(selected ? t.selected : t.hover)).cursor_pointer().accessibility_label(`${commit.subject}, ${commit.hash.slice(0, 8)}`)
            .child(h_flex().w_full().h_full().min_w(0).items_center().gap(7)
              .child(graphCell(graph.rows[i], commit.hash === data.head, graphWidth))
              .child(v_flex().flex_1().min_w(0).gap(3)
                .child(div().truncate().text_size(12).font_semibold().child(commit.subject))
                .child(h_flex().gap(6).min_w(0).items_center()
                  .when(refs.length > 0, e => e.child(div().min_w(0).max_w(this.width < 560 ? 150 : 300).truncate().text_size(10).text_color(t.accent).tooltip(refs.join(" · ")).child(refs.join(" · "))))
                  .child(secondary(`${commit.author} · ${ago(commit.time)}`))))
              .when(this.width >= 560, e => e.child(div().flex_none().font_family(settings().font_family).text_size(11).text_color(t.dim).child(commit.hash.slice(0, 7)))));
        }).min_w(graphWidth + 220))))
      .when(Boolean(data?.more), e => e.child(bar(34).child(button("more-commits", "Load older commits", cx => { this.limit += 150; this.refresh(cx); cx.notify(); }, { small: true, enabled: !this.loading && !this.busy }))));
  }
  prList() {
    const t = theme(), rows = this.prs || [];
    return v_flex().flex_1().min_h(0).min_w(0)
      .child(bar(40).child(segments("pr-filter", [["all", "This repo"], ["mine", "Mine"], ["review", this.width < 360 ? "To review" : "Review requested"]], this.filter, (filter, cx) => {
        this.filter = filter; this.prs = null; this.prLimit = 50; this.prEpoch++; this.prLoading = false; this.loadPRs(cx); cx.notify();
      })))
      .when(Boolean(this.prError), e => e.child(empty("Couldn’t load pull requests", this.prError)).child(bar().child(button("retry-pr", "Retry", cx => this.loadPRs(cx), { enabled: !this.prLoading }))))
      .when(!this.prError && !rows.length, e => e.child(empty(this.prLoading ? "Loading pull requests…" : "No open pull requests", this.prLoading ? "Reading this repository through GitHub CLI." : this.filter === "all" ? "Open pull requests for this repository appear here." : "Try This repo to see everyone’s pull requests.")))
      .when(rows.length > 0, e => e.child(this.list("prs", rows, 76, pr => {
        const on = this.selected?.item?.number === pr.number;
        const color = pr.checks.kind === "failed" ? t.ansi1 : pr.checks.kind === "pending" ? t.working : pr.checks.kind === "passed" ? t.ansi2 : t.muted;
        const current = !pr.isCrossRepository && pr.headRefName === this.data?.branch;
        return div().id(`pr-${pr.number}`).flex().items_center().w_full().h(76).px(14).bg(on ? t.selected : "#00000000").text_color(t.foreground)
          .hover(s => s.bg(on ? t.selected : t.hover)).cursor_pointer()
          .accessibility_label(`Pull request ${pr.number}: ${pr.title}`)
          .child(v_flex().w_full().min_w(0).gap(5)
            .child(h_flex().gap(7).min_w(0).items_center().child(svg(icon("pr")).size(13).flex_none().text_color(pr.isDraft ? t.dim : t.ansi2))
              .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12).child(pr.title)))
            .child(secondary(`#${pr.number} · ${pr.author?.login || "ghost"} · ${pr.headRefName} → ${pr.baseRefName}`))
            .child(h_flex().gap(8).min_w(0).items_center().child(div().text_size(10).text_color(color).child(pr.checks.label))
              .child(div().min_w(0).truncate().text_size(10).text_color(t.muted).child(reviewLabel(pr)))
              .when(current, e => e.child(pill("Current", t.accent)))));
      })))
      .when(Boolean(this.prMore), e => e.child(bar(34).child(button("more-prs", "Load more pull requests", cx => { this.prLimit += 50; this.loadPRs(cx); cx.notify(); }, { small: true, enabled: !this.prLoading }))));
  }
  branches() {
    const t = theme(), query = this.search.value().toLowerCase();
    const rows = (this.data?.branches || []).filter(b => b.name.toLowerCase().includes(query));
    return v_flex().flex_1().min_h(0).min_w(0)
      .child(bar(40).child(div().flex_1().min_w(0).h(26).px(8).rounded(6).bg(t.background).border_1().border_color(t.input)
        .child(Input.new(this.search).h_full().text_size(12).text_color(t.foreground))))
      .child(bar().child(label("Branches")).child(secondary(String(rows.length))).child(div().flex_1())
        .child(button("back-history", "Back", cx => this.setMode("history", cx), { small: true })))
      .when(!rows.length, e => e.child(empty("No matching branches", "Try a shorter name. Remote branches reflect the last fetch.")))
      .when(rows.length > 0, e => e.child(this.list("branches", rows, 48, branch => {
        const current = !branch.remote && branch.name === this.data.branch;
        const occupied = branch.worktree && branch.worktree !== this.data.root;
        return div().id(`branch-${branch.ref}`).flex().items_center().w_full().h(48).px(14).text_color(t.foreground).bg(current || this.cursor === branch.ref ? t.selected : "#00000000")
          .hover(s => s.bg(t.hover)).when(!occupied && !current, e => e.cursor_pointer()).when(Boolean(occupied), e => e.opacity(0.65))
          .accessibility_label(occupied ? `${branch.name}, checked out in ${branch.worktree}` : `Switch to ${branch.name}`)
          .tooltip(occupied ? `Checked out in ${branch.worktree}` : branch.name)
          .child(h_flex().w_full().min_w(0).gap(8).items_center()
            .child(svg(icon(current ? "check" : "git-branch")).size(13).flex_none().text_color(current ? t.accent : t.muted))
            .child(v_flex().flex_1().min_w(0).gap(3).child(div().truncate().text_size(12).child(branch.name))
              .child(secondary(occupied ? `In ${branch.worktree}` : current ? "Current branch" : branch.remote ? "Remote · creates a tracking branch" : branch.upstream || "Local · not published"))));
      })));
  }
  detailView(wide) {
    const t = theme(), selected = this.selected, pr = selected.kind === "pr", item = this.detail || selected.item;
    return v_flex().min_h(0).min_w(0).flex_none().border_color(t.border)
      .when(wide, e => e.w(Math.min(420, this.width * 0.4)).border_l(1))
      .when(!wide, e => e.h(Math.min(300, Math.max(150, this.height * 0.38))).border_t(1))
      .child(bar().child(label(pr ? `Pull request #${selected.item.number}` : selected.item.hash.slice(0, 8))).child(div().flex_1())
        .child(button("close-detail", "", cx => { this.selected = null; this.detail = null; this.detailEpoch++; cx.notify(); }, { small: true, ghost: true, icon: "x", tooltip: "Close details" })))
      .when(pr, e => e.child(bar(40)
        .child(button("checkout-pr", "Check out", cx => this.ask({ kind: "pr", pr: item }, cx), { icon: "git-branch", enabled: !this.busy && !this.error && !this.loading && !this.detailLoading && Boolean(this.detail) }))
        .child(button("open-pr", "GitHub", cx => { if (/^https:\/\//.test(item.url || "")) cx.open_url(item.url); }, { tooltip: "Open pull request on GitHub" }))))
      .child(v_flex().id(`git-detail-${pr ? selected.item.number : selected.item.hash}`).flex_1().min_h(0).overflow_y_scrollbar().p(14).gap(10)
        .when(this.detailLoading, e => e.child(secondary("Loading details…")))
        .when(Boolean(this.detailError), e => e.child(div().text_size(12).text_color(t.blocked).child(this.detailError)))
        .when(!pr && Boolean(this.detail), e => e.child(div().font_family(settings().font_family).text_size(11).text_color(t.muted).child(this.detail)))
        .when(pr && Boolean(this.detail), e => e
          .child(div().font_semibold().text_size(13).child(item.title))
          .child(secondary(`${item.headRefName} → ${item.baseRefName}`))
          .child(h_flex().gap(8).items_center().child(pill(reviewLabel(item), item.reviewDecision === "CHANGES_REQUESTED" ? t.ansi1 : t.muted)).child(secondary(item.checks.label)))
          .when(item.mergeable === "CONFLICTING", e => e.child(div().text_size(12).text_color(t.ansi1).child("This pull request has merge conflicts.")))
          .child(secondary(`${item.changedFiles} files · +${item.additions} −${item.deletions}`))
          .child(TextView.markdown("git-pr-body", item.body || "No description provided.").selectable(true).w_full().text_size(12).text_color(t.foreground)
            .on_link_click((url, cx) => { if (/^https?:\/\//.test(url)) cx.open_url(url); }))
          .when(item.bodyTruncated, e => e.child(secondary("Description shortened. Open GitHub for the full text.")))
          .when(item.checksList?.length > 0, e => e.child(label(item.checksList.length > 80 ? `Checks · first 80 of ${item.checksList.length}` : "Checks")).children(item.checksList.slice(0, 80).map((check, i) =>
            button(`check-${i}`, `${check.name} · ${check.state.toLowerCase().replace(/_/g, " ")}`, cx => { if (/^https:\/\//.test(check.url || "")) cx.open_url(check.url); }, { small: true, maxW: wide ? 380 : this.width - 30, enabled: /^https:\/\//.test(check.url || "") }))))) );
  }
  confirmation() {
    const { action, snapshot } = this.pending;
    const title = action.kind === "push" ? `${snapshot.upstream ? "Push" : "Publish"} ${snapshot.branch}?` : action.kind === "pull" ? `Pull into ${snapshot.branch}?` : action.kind === "pr" ? `Check out PR #${action.pr.number}?` : `Switch to ${action.branch.name}?`;
    const explanation = action.kind === "push" ? `Destination: ${action.remote} → ${action.target.replace(/^refs\/heads\//, "")}. No force push.`
      : action.kind === "pull" ? `From ${snapshot.upstream}. Fast-forward only; local changes are never stashed automatically.`
      : "This changes the current checkout for every terminal using it. Commit or stash local changes first.";
    return v_flex().flex_none().px(14).py(12).gap(8).bg(theme().surface).border_t(1).border_color(theme().border)
      .child(label(title)).child(div().text_size(12).text_color(theme().muted).child(explanation))
      .child(secondary(`${snapshot.root}${this.where.on ? ` · ${this.where.on}` : ""}`))
      .child(h_flex().gap(8).justify_end().child(button("cancel-action", "Cancel", cx => { this.pending = null; cx.notify(); }, { enabled: !this.busy }))
        .child(button("confirm-action", this.busy ? "Working…" : "Confirm", cx => this.perform(cx), { primary: true, enabled: !this.busy })));
  }
  render(cx) {
    const t = theme(), p = props() || {};
    if (this.toolbar) {
      const on = dockState(p.dock)?.on;
      return h_flex().size_full().pr(10).justify_end().items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(button("open-git", "", () => openGit(p.dock), { icon: "github", ghost: true, selected: on, tooltip: on ? "Close Git" : "Git · commits and pull requests" }));
    }
    if (!this.fixed && !this.busy) {
      const where = currentLocation(this.where);
      if (contextKey(where) !== contextKey(this.where)) this.enter(where, cx);
      else this.where = where;
    }
    const data = this.data, width = this.width, wide = width >= 760;
    const repo = (data?.root || this.where.cwd || "").split(/[\\/]/).filter(Boolean).pop();
    const error = this.operationError || this.error;
    const canSync = Boolean(data?.branch && data?.head) && !this.busy && !this.loading && !this.error;
    const sync = !data ? "Not connected" : data.conflicts ? `${data.conflicts} conflicts` : data.dirty ? `${data.dirty} changed` : "Clean working tree";
    return v_flex().id("git").size_full().min_w(0).min_h(0).bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .when(!p.overlay && !p.framed, e => e.rounded(10).overflow_hidden().border_1().border_color(t.border))
      .on_size_change((size, cx) => { if (this.width !== size.width || this.height !== size.height) { this.width = size.width; this.height = size.height; cx.notify(); } })
      .on_mouse_down("left", stop)
      .on_key_down((event, cx) => {
        if (this.busy) return;
        if (!this.pending && ["up", "down", "enter"].includes(event.keystroke)) {
          const id = this.mode === "history" ? "commits" : this.mode;
          const rows = id === "commits" ? this.data?.commits || [] : id === "prs" ? this.prs || [] : (this.data?.branches || []).filter(b => b.name.toLowerCase().includes(this.search.value().toLowerCase()));
          if (!rows.length) return;
          const key = row => String(row.ref || row.hash || row.number);
          const at = rows.findIndex(row => key(row) === this.cursor);
          const next = event.key === "enter" ? Math.max(0, at) : Math.min(rows.length - 1, Math.max(0, at + (event.key === "up" ? -1 : 1)));
          this.cursor = key(rows[next]);
          this.scroll[id].scroll_to_item(next, "center");
          if (event.key === "enter" || id !== "branches") this.activate(id, rows[next], cx);
          cx.stop_propagation(); cx.notify(); return;
        }
        if (event.key !== "escape") return;
        if (this.pending) this.pending = null;
        else if (this.selected) { this.selected = null; this.detail = null; this.detailEpoch++; }
        else if (this.mode === "branches") this.setMode("history", cx);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(bar(42).gap(10)
        .child(svg(icon("github")).size(16).flex_none().text_color(t.muted))
        .when(width >= 480, e => e.child(div().font_semibold().child("Git")).child(div().w(1).h(16).flex_none().bg(t.border)))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12).tooltip(data?.root || this.where.cwd || "No checkout").child(repo || "No checkout"))
        .child(button("refresh", "", cx => this.refresh(cx, true), { icon: "refresh", tooltip: "Refresh Git and pull requests", enabled: !this.loading && !this.prLoading && !this.busy }))
        .when(Boolean(p.overlay || p.dock), e => e.child(button("close-git", "", () => this.closePanel(), { icon: "x", ghost: true, tooltip: "Close Git", enabled: !this.busy }))))
      .child(bar(40).child(segments("mode", [["history", "History"], ["prs", "Pull requests"]], this.mode, (mode, cx) => this.setMode(mode, cx)))
        .child(div().flex_1())
        .when(width >= 560, e => e.child(secondary(this.where.on || "This computer"))))
      .child(bar(40)
        .child(button("branches", data?.branch || (data?.head ? "Detached HEAD" : "Branches"), cx => this.setMode(this.mode === "branches" ? "history" : "branches", cx), { icon: "git-branch", maxW: Math.max(70, width - 210), selected: this.mode === "branches", enabled: Boolean(data) && !this.busy, tooltip: data?.branch ? `Switch branch · ${data.branch}` : "Switch branch" }))
        .child(div().flex_1())
        .child(button("pull", "Pull", cx => this.ask({ kind: "pull" }, cx), { icon: "pull", enabled: canSync && Boolean(data?.upstream), tooltip: data?.upstream ? `Pull from ${data.upstream} · fast-forward only` : "Publish a branch before pulling" }))
        .child(button("push", data?.upstream ? "Push" : "Publish", cx => this.ask({ kind: "push" }, cx), { icon: "push", enabled: canSync && Boolean(data?.remotes.length), tooltip: data?.upstream ? `Push ${data.ahead} outgoing commits` : "Publish branch and set its upstream" })))
      .when(Boolean(error), e => e.child(v_flex().flex_none().px(14).py(8).gap(6).bg(tint(t.blocked, "1a")).border_b(1).border_color(t.border)
        .child(div().text_size(12).text_color(t.blocked).child(error))
        .child(button("dismiss-error", "Dismiss", cx => { this.operationError = null; this.error = null; cx.notify(); }, { small: true }))))
      .when(Boolean(this.notice), e => e.child(div().flex_none().px(14).py(7).text_size(11).text_color(t.ansi2).child(this.notice)))
      .child((wide ? h_flex().items_stretch() : v_flex()).flex_1().min_h(0).min_w(0)
        .child(this.mode === "prs" ? this.prList() : this.mode === "branches" ? this.branches() : this.history())
        .when(Boolean(this.selected) && this.mode !== "branches", e => e.child(this.detailView(wide))))
      .when(Boolean(this.pending), e => e.child(this.confirmation()))
      .child(h_flex().h(26).flex_none().px(14).gap(8).items_center().border_t(1).border_color(t.border).text_size(11)
        .child(div().size(6).flex_none().rounded_full().bg(error ? t.blocked : this.loading || this.busy ? t.working : t.idle))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(this.busy ? "Git operation in progress…" : this.loading ? "Refreshing…" : `${sync}${data?.upstream ? ` · ${data.ahead} ahead · ${data.behind} behind` : data ? " · no upstream" : ""}`))
        .when(Boolean(this.prLoading), e => e.child(secondary("Reading PRs…"))));
  }
}
