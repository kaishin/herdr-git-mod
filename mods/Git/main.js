import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Button, InputState, Input, TextView, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { exec, props, focused, spaces, panes, theme, settings, layout, run, openOverlay, nextCommand, shared, setShared, readTextFile, appHome } from "herdr";
import { codewalkerInstalled, reviewTarget, commitReviewProblem, commitReviewArgs } from "./codewalker.js";
import { GitClient } from "./client.js";
import { layoutLanes } from "./lanes.js";
import { dockExpand, RESTORE_TIMEOUT } from "./dock-expand.js";
import { contextKey, ago, tint, refLabel, reviewLabel, checksSummary, prProblem, shortDate } from "./model.js";
import { button, segments, bar, secondary, pill, empty, graphCell, graphCellWidth, checkColor, icon, stop, ROW, MOD } from "./ui.js";

const since = time => { const rel = ago(time); return rel === "now" ? "just now" : `${rel} ago`; };
// Below this width the PR filter takes its own row instead of sharing the mode row.
const PR_FILTER_INLINE = 500;
// Three lines: 16px title, 1px, 14px byline, 5px, 16px status, with 8px above and below.
const PR_ROW = 68;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children || []) { const result = find(child, id); if (result) return result; }
  return null;
}
function dockState(dock) {
  if (!dock) return null;
  const panel = find(layout(), dock.panel), stack = find(layout(), dock.stack);
  if (!panel || !stack?.children?.some(n => n.id === dock.child && n.content?.mod === MOD)) return null;
  return { on: !panel.hidden && stack.active === dock.child };
}
function currentLocation(previous) {
  const space = spaces().find(s => s.active), f = focused();
  if (!space) return { cwd: "", on: null, space: null };
  const pane = panes().find(p => p.pane === f?.pane);
  const cwd = pane?.cwd || f?.cwd;
  const on = f?.pane === null && cwd ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space.machine;
  if (cwd) return { cwd, on, space: space.id, pane: pane?.pane || null };
  return previous?.space === space.id ? previous : { cwd: space.folder, on: space.machine, space: space.id, pane: null };
}
function codewalkerHome() { try { return appHome(); } catch { return null; } }
// One per mod copy; the receipt in shared state is the only expansion state.
const expander = dockExpand({ layout, run, shared, setShared });
function openGit(dock, cx) {
  const state = dockState(dock);
  if (state) {
    if (state.on) {
      // Restore first: commands run in order, so the workspace never stays empty.
      if (expander.state(dock).expanded) { expander.restore(); afterExpansion(cx); }
      run("layout.hide", { id: dock.panel });
    }
    else { run("layout.select", { stack: dock.stack, child: dock.child }); run("layout.show", { id: dock.panel }); }
  } else {
    const where = currentLocation(null);
    openOverlay({ mod: MOD, kind: "window", key: "git", width: 1100, height: 720, props: { folder: where.cwd, on: where.on, pane: where.pane } });
  }
}

// run() only queues, so check again later even if nothing re-renders. One task:
// each new expand/restore replaces it, so its timeout counts from the latest start.
let expansionTimer = null;
function stopExpansionTimer() { expansionTimer?.cancel(); expansionTimer = null; }
function afterExpansion(cx) {
  stopExpansionTimer();
  expansionTimer = cx?.timer?.after(RESTORE_TIMEOUT + 250, cx => { expansionTimer = null; expander.reconcile(); cx.notify(); }) || null;
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
    this.where = this.fixed ? { cwd: p.folder, on: p.on || null, pane: p.pane || null } : currentLocation(null);
    this.width = p.overlay ? 1100 : 368;
    this.height = 720;
    this.mode = "history";
    this.filter = "all";
    this.all = true;
    this.limit = 150;
    this.prLimit = 50;
    this.epoch = 0;
    this.detailEpoch = 0;
    // Codewalker shows commit diffs: true, false, or null while checking.
    this.codewalker = null;
    this.codewalkerEpoch = 0;
    this.openingDiff = false;
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
    cx.timer.every(60000, cx => { if (this.visible() && !this.pending) this.loadPRs(cx); });
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
        if (command === "refresh") this.refresh(cx, true);
        if (["history", "prs", "branches"].includes(command)) this.setMode(command, cx);
        // Git.expand: the expand button's toggle, for keys and scripts. Docked copies only.
        if (command === "expand") this.toggleExpansion(cx);
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
      finally { if (epoch === this.epoch) { this.loading = false; if (prs) this.loadPRs(cx); cx.notify(); } }
    });
  }
  loadPRs(cx) {
    if (this.busy || this.prLoading || !this.data) return;
    if (!this.data.remotes.length) { this.prEpoch++; this.prs = null; this.prError = prProblem("", [], this.where.on); cx.notify(); return; }
    const epoch = ++this.prEpoch, client = this.client, filter = this.filter, remotes = this.data.remotes;
    this.prLoading = true;
    cx.spawn(async cx => {
      try {
        const result = await client.prs(filter, this.prLimit);
        if (epoch !== this.prEpoch) return;
        this.prs = result.rows;
        this.prMore = result.more;
        this.prError = null;
      } catch (e) { if (epoch === this.prEpoch) { this.prs = null; this.prError = prProblem(e.message, remotes, this.where.on); } }
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
  checkCodewalker(cx) {
    const epoch = ++this.codewalkerEpoch;
    cx.spawn(async cx => {
      const installed = await codewalkerInstalled(readTextFile, codewalkerHome());
      if (epoch === this.codewalkerEpoch && installed !== this.codewalker) { this.codewalker = installed; cx.notify(); }
    });
  }
  // Opens the commit in a new Codewalker pane beside the pane this panel follows.
  // Target, root and ID are fixed now; focus can change while Codewalker is checked again.
  openCommitDiff(item, cx) {
    if (this.openingDiff) return;
    const request = { on: this.where.on, root: this.data?.root, hash: item.hash, pane: reviewTarget(panes(), focused(), this.where.pane)?.pane || null };
    this.openingDiff = true;
    const epoch = ++this.codewalkerEpoch;
    cx.spawn(async cx => {
      const installed = await codewalkerInstalled(readTextFile, codewalkerHome());
      if (epoch === this.codewalkerEpoch) this.codewalker = installed;
      const live = panes().some(p => p.pane === request.pane);
      const problem = commitReviewProblem({ ...request, installed, pane: live ? request.pane : null });
      if (problem) this.operationError = problem;
      else {
        try { run("pane.split", commitReviewArgs(request)); }
        catch (e) { this.operationError = `Codewalker did not open: ${e?.message || e}`; }
      }
      this.openingDiff = false;
      cx.notify();
    });
    cx.notify();
  }
  select(item, kind, cx) {
    if (kind === "commit") this.checkCodewalker(cx);
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
  // Header controls. The branch name doubles as the branch picker, as in Codewalker’s header.
  branchSwitch() {
    const t = theme(), data = this.data, on = this.mode === "branches", enabled = !this.busy;
    const name = data.branch || "Detached HEAD";
    const where = `${data.root}${this.where.on ? ` · ${this.where.on}` : ""}`;
    // Leads the header: the negative margin puts its icon on the 14px gutter while the hover fill keeps its padding.
    return Button.new("branches").h(26).min_w(0).ml(-6).px(6).rounded(6).text_size(12).font_semibold().bg(on ? t.selected : "#00000000").text_color(t.foreground)
      .when(enabled, e => e.cursor_pointer().hover(s => s.bg(on ? t.selected : t.hover)))
      .disabled(!enabled).tooltip(on ? "Close branch list" : `Switch branch · ${where}`).accessibility_label(`Switch branch, current ${name}`)
      .on_mouse_down("left", stop).on_click((_event, cx) => { if (enabled) this.setMode(on ? "history" : "branches", cx); })
      .child(h_flex().min_w(0).gap(6).items_center()
        .child(svg(icon("git-branch")).size(13).flex_none().text_color(on ? t.foreground : t.muted))
        .child(div().min_w(0).truncate().child(name)));
  }
  branchSearch() {
    const t = theme(), count = this.branchRows().length;
    return bar(40)
      .child(div().flex_1().min_w(0).h(26).px(8).rounded(6).bg(t.background).border_1().border_color(t.input).cursor_text().on_mouse_down("left", stop)
        .child(Input.new(this.search).h_full().text_size(12).text_color(t.foreground)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`${count} ${count === 1 ? "branch" : "branches"}`))
      .child(button("back-history", "Done", cx => this.setMode("history", cx), { tooltip: "Back to history" }));
  }
  branchRows() {
    const query = this.search.value().toLowerCase();
    return (this.data?.branches || []).filter(b => b.name.toLowerCase().includes(query));
  }
  prFilter() {
    return segments("pr-filter", [["all", "This repo"], ["mine", "Mine"], ["review", "To review"]], this.filter, (filter, cx) => {
      this.filter = filter; this.prs = null; this.prLimit = 50; this.prEpoch++; this.prLoading = false; this.loadPRs(cx); cx.notify();
    });
  }
  loadMore(id, text, action, enabled) {
    return h_flex().h(36).flex_none().px(14).items_center().border_t(1).border_color(theme().border)
      .child(button(id, text, action, { small: true, enabled }));
  }
  history() {
    const t = theme(), data = this.data, commits = data?.commits || [];
    const graph = this.graph;
    const graphWidth = graphCellWidth(graph?.width || 1);
    // Keep every lane: unusual high-fanout histories scroll horizontally, never fake a straight rail.
    return v_flex().flex_1().min_h(0).min_w(0)
      .when(!commits.length, e => e.child(empty(this.loading ? "Reading history…" : data ? "No commits yet" : "Open a checkout", data ? "Your first commit will appear here." : "Git follows the focused terminal’s folder.")))
      .when(commits.length > 0, e => e.child(v_flex().id("history-horizontal").flex_1().min_h(0).min_w(0).overflow_x_scrollbar()
        .child(this.list("commits", commits, ROW, (commit, i) => {
          const selected = this.selected?.item?.hash === commit.hash;
          const refs = commit.refs.map(refLabel);
          return div().id(`commit-${commit.hash}`).flex().items_center().h(ROW).w_full().px(14).bg(selected ? t.selected : "#00000000").text_color(t.foreground)
            .hover(s => s.bg(selected ? t.selected : t.hover)).cursor_pointer().accessibility_label(`${commit.subject}, ${commit.hash.slice(0, 8)}`)
            .child(h_flex().w_full().h_full().min_w(0).items_center().gap(8)
              .child(graphCell(graph.rows[i], commit.hash === data.head, graphWidth))
              // Explicit line heights keep the subject and its byline one tight pair.
              .child(v_flex().flex_1().min_w(0).gap(1)
                .child(div().truncate().text_size(12).line_height("16px").font_semibold().child(commit.subject))
                .child(h_flex().gap(6).min_w(0).items_center().line_height("14px")
                  .when(refs.length > 0, e => e.child(div().min_w(0).max_w(this.width < 560 ? 150 : 300).truncate().text_size(11).text_color(t.accent).tooltip(refs.join(" · ")).child(refs.join(" · "))))
                  .child(secondary(`${commit.author} · ${ago(commit.time)}`))))
              .when(this.width >= 560, e => e.child(div().flex_none().font_family(settings().font_family).text_size(11).text_color(t.dim).child(commit.hash.slice(0, 7)))));
        }).min_w(graphWidth + 220))))
      .when(Boolean(data?.more), e => e.child(this.loadMore("more-commits", "Load older commits", cx => { this.limit += 150; this.refresh(cx); cx.notify(); }, !this.loading && !this.busy)));
  }
  prList() {
    const t = theme(), rows = this.prs || [];
    return v_flex().flex_1().min_h(0).min_w(0)
      .when(Boolean(this.prError), e => e.child(this.problemView(this.prError)))
      .when(!this.prError && !rows.length, e => e.child(empty(this.prLoading ? "Loading pull requests…" : "No open pull requests", this.prLoading ? "Reading this repository through GitHub CLI." : this.filter === "all" ? "Open pull requests for this repository appear here." : "Try This repo to see everyone’s pull requests.")))
      .when(rows.length > 0, e => e.child(this.list("prs", rows, PR_ROW, pr => {
        const on = this.selected?.item?.number === pr.number;
        const current = !pr.isCrossRepository && pr.headRefName === this.data?.branch;
        // Title and byline are one tight pair, as in commit rows; status sits a step below.
        // The icon has its own column so every line shares the title’s left edge.
        return div().id(`pr-${pr.number}`).flex().items_center().w_full().h(PR_ROW).px(14).bg(on ? t.selected : "#00000000").text_color(t.foreground)
          .hover(s => s.bg(on ? t.selected : t.hover)).cursor_pointer()
          .accessibility_label(`Pull request ${pr.number}: ${pr.title}${pr.isDraft ? ", draft" : ""}`)
          .child(h_flex().w_full().min_w(0).items_start().gap(8)
            .child(svg(icon("pr")).size(13).mt(2).flex_none().text_color(pr.isDraft ? t.dim : t.ansi2))
            .child(v_flex().flex_1().min_w(0)
              .child(div().min_w(0).truncate().font_semibold().text_size(12).line_height("16px").text_color(pr.isDraft ? t.muted : t.foreground).child(pr.title))
              .child(h_flex().mt(1).min_w(0).gap(4).items_center().text_size(11).line_height("14px")
                .child(div().flex_none().text_color(t.dim).child(`#${pr.number}`))
                .child(div().min_w(0).truncate().text_color(t.muted).child(`${pr.author?.login || "ghost"} · ${pr.headRefName} → ${pr.baseRefName}`)))
              .child(h_flex().mt(5).h(16).min_w(0).gap(6).items_center().text_size(11).line_height("14px")
                .child(div().size(6).flex_none().rounded_full().bg(checkColor(pr.checks.kind)))
                .child(div().flex_none().text_color(pr.checks.kind === "failed" ? t.ansi1 : t.muted).child(pr.checks.label))
                .child(div().flex_none().text_color(t.dim).child("·"))
                .child(div().min_w(0).truncate().text_color(pr.reviewDecision === "CHANGES_REQUESTED" ? t.ansi1 : t.muted).child(reviewLabel(pr)))
                .when(current, e => e.child(pill("Current", t.accent))))));
      })))
      .when(Boolean(this.prMore), e => e.child(this.loadMore("more-prs", "Load more pull requests", cx => { this.prLimit += 50; this.loadPRs(cx); cx.notify(); }, !this.prLoading)));
  }
  // A setup problem gets a title, its fix, and a command to copy. Raw gh output only for unknown causes.
  problemView(problem) {
    const t = theme(), copied = this.copied === (problem.copy || problem.command);
    return v_flex().px(22).py(28).gap(14)
      .child(v_flex().gap(6)
        .child(div().font_semibold().text_size(13).child(problem.title))
        .child(div().text_size(12).text_color(t.muted).child(problem.detail)))
      .when(Boolean(problem.command), e => e.child(h_flex().h(32).pl(10).pr(4).gap(8).items_center().rounded(6).bg(t.surface).border_1().border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().font_family(settings().font_family).text_size(12).text_color(t.foreground).child(problem.command))
        .child(button("copy-command", copied ? "Copied" : "Copy", cx => { cx.write_to_clipboard(problem.copy || problem.command); this.copied = problem.copy || problem.command; cx.notify(); },
          { small: true, ghost: true, tooltip: problem.copy ? "Copy the command; add the URL after pasting" : "Copy the command" }))))
      .when(Boolean(problem.raw), e => e.child(div().max_h(160).p(10).rounded(6).bg(t.surface).border_1().border_color(t.border)
        .font_family(settings().font_family).text_size(11).text_color(t.muted).child(problem.raw)))
      .child(h_flex().gap(8)
        .when(Boolean(problem.retry), e => e.child(button("retry-pr", this.prLoading ? "Retrying…" : "Retry", cx => this.loadPRs(cx), { enabled: !this.prLoading })))
        .when(!problem.retry, e => e.child(button("refresh-pr", "Refresh", cx => this.refresh(cx, true), { icon: "refresh", enabled: !this.loading && !this.busy, tooltip: "Read the remotes again" }))));
  }
  branches() {
    const t = theme(), rows = this.branchRows();
    return v_flex().flex_1().min_h(0).min_w(0)
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
            .child(v_flex().flex_1().min_w(0).gap(1).line_height("14px").child(div().truncate().text_size(12).line_height("16px").when(current, e => e.font_semibold()).child(branch.name))
              .child(secondary(occupied ? `In ${branch.worktree}` : current ? "Current branch" : branch.remote ? "Remote · creates a tracking branch" : branch.upstream || "Local · not published"))));
      })));
  }
  detailView(wide) {
    const t = theme(), selected = this.selected, pr = selected.kind === "pr", item = this.detail || selected.item;
    return v_flex().min_h(0).min_w(0).flex_none().border_color(t.border)
      .when(wide, e => e.w(Math.min(420, this.width * 0.4)).border_l(1))
      .when(!wide, e => e.h(Math.min(440, Math.max(180, this.height * 0.5))).border_t(1))
      // One header row: identity, then the actions for this item.
      .child(bar(40).child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12).child(pr ? `Pull request #${selected.item.number}` : `Commit ${selected.item.hash.slice(0, 8)}`))
        .when(pr, e => e
          .child(button("checkout-pr", "Check out", cx => this.ask({ kind: "pr", pr: item }, cx), { small: true, icon: "git-branch", enabled: !this.busy && !this.error && !this.loading && !this.detailLoading && Boolean(this.detail), tooltip: "Check out this pull request in the current checkout" }))
          .child(button("open-pr", "", cx => { if (/^https:\/\//.test(item.url || "")) cx.open_url(item.url); }, { small: true, icon: "github", enabled: /^https:\/\//.test(item.url || ""), tooltip: "Open pull request on GitHub" })))
        // Shown only when Codewalker is installed; the files group says how to get it.
        .when(!pr && this.codewalker === true, e => {
          const problem = this.openingDiff ? "Opening Codewalker…" : commitReviewProblem({ installed: this.codewalker, on: this.where.on, root: this.data?.root, hash: selected.item.hash, pane: reviewTarget(panes(), focused(), this.where.pane)?.pane });
          return e.child(button("open-diff", "View diff", cx => this.openCommitDiff(selected.item, cx), { small: true, enabled: !problem, tooltip: problem || "Open this commit's diff in Codewalker, beside the current pane" }));
        })
        .when(!pr, e => e.child(button("copy-hash", this.copied === selected.item.hash ? "Copied" : "Copy ID", cx => { cx.write_to_clipboard(selected.item.hash); this.copied = selected.item.hash; cx.notify(); }, { small: true, tooltip: `Copy ${selected.item.hash}` })))
        .child(button("close-detail", "", cx => { this.selected = null; this.detail = null; this.detailEpoch++; cx.notify(); }, { small: true, ghost: true, icon: "x", tooltip: "Close details" })))
      .child(v_flex().id(`git-detail-${pr ? selected.item.number : selected.item.hash}`).flex_1().min_h(0).overflow_y_scrollbar().px(14).pt(12).pb(16).gap(14)
        .when(this.detailLoading && pr, e => e.child(secondary("Loading details…")))
        .when(Boolean(this.detailError), e => e.child(div().text_size(12).text_color(t.blocked).child(this.detailError)))
        .when(!pr, e => e.children(this.commitBody(selected.item)))
        .when(pr && Boolean(this.detail), e => e
          // Title group: what, where, how big.
          .child(v_flex().gap(4)
            .child(div().font_semibold().text_size(13).child(item.title))
            .child(secondary(`${item.headRefName} → ${item.baseRefName} · ${item.changedFiles} ${item.changedFiles === 1 ? "file" : "files"} · +${item.additions} −${item.deletions}`)))
          // Status group: review and CI stay separate facts.
          .child(v_flex().gap(6)
            .child(h_flex().gap(8).items_center()
              .child(pill(reviewLabel(item), item.reviewDecision === "CHANGES_REQUESTED" ? t.ansi1 : item.reviewDecision === "APPROVED" ? t.ansi2 : t.muted))
              .child(div().text_size(11).text_color(checkColor(item.checks.kind)).child(item.checks.label)))
            .when(item.mergeable === "CONFLICTING", e => e.child(div().text_size(12).text_color(t.ansi1).child("This pull request has merge conflicts."))))
          .child(v_flex().gap(6)
            .child(TextView.markdown("git-pr-body", item.body || "No description provided.").selectable(true).w_full().text_size(12).text_color(item.body ? t.foreground : t.muted)
              .on_link_click((url, cx) => { if (/^https?:\/\//.test(url)) cx.open_url(url); }))
            .when(item.bodyTruncated, e => e.child(secondary("Description shortened. Open GitHub for the full text."))))
          .when(item.checksList?.length > 0, e => e.child(v_flex().gap(2)
            .child(div().pb(4).text_size(11).font_semibold().text_color(t.dim).child(item.checksList.length > 80 ? `Checks · first 80 of ${item.checksList.length}` : "Checks"))
            .children(item.checksList.slice(0, 80).map((check, i) => this.checkRow(check, i)))))));
  }
  // What the commit says, who made it, where it sits, and what it touched. The list row
  // already holds the subject and author, so those show at once; files follow.
  commitBody(item) {
    const t = theme(), detail = this.detail?.hash === item.hash ? this.detail : null, commit = detail || item;
    const refs = (commit.refs || []).map(refLabel).filter(r => r !== "HEAD");
    const loaded = this.data?.commits || [];
    const fact = (name, value) => h_flex().min_h(22).min_w(0).gap(10).items_center()
      .child(div().w(64).flex_none().text_size(11).line_height("18px").text_color(t.dim).child(name))
      .child(h_flex().flex_1().min_w(0).flex_wrap().gap(6).items_center().text_size(12).line_height("18px").child(value));
    const sameCommitter = !detail || (detail.committer === detail.author && Math.abs(detail.committerTime - detail.time) < 120);
    const files = detail?.files || [];
    return [
      v_flex().gap(6)
        .child(div().font_semibold().text_size(13).line_height("18px").child(commit.subject))
        .when(Boolean(detail?.body), e => e.child(TextView.markdown(`git-commit-body-${item.hash}`, detail.body).selectable(true).w_full().text_size(12).text_color(t.muted)
          .on_link_click((url, cx) => { if (/^https?:\/\//.test(url)) cx.open_url(url); })))
        .when(Boolean(detail?.bodyTruncated), e => e.child(secondary("Message shortened."))),
      v_flex().gap(2)
        .child(fact("Author", div().min_w(0).truncate().tooltip(`${detail?.email || commit.author} · ${shortDate(commit.time)}`).child(`${commit.author} · ${since(commit.time)}`)))
        .when(!sameCommitter, e => e.child(fact("Committed", div().min_w(0).truncate().tooltip(shortDate(detail.committerTime)).child(`${detail.committer} · ${since(detail.committerTime)}`))))
        .child(fact(commit.parents.length > 1 ? "Parents" : "Parent", commit.parents.length ? h_flex().gap(6).children(commit.parents.map((hash, i) => {
          const at = loaded.findIndex(c => c.hash === hash);
          return button(`parent-${i}`, hash.slice(0, 7), cx => this.goToCommit(at, cx), { small: true, enabled: at >= 0, tooltip: at >= 0 ? `Show ${hash.slice(0, 8)}` : "Not in the loaded history" });
        })) : div().text_color(t.muted).child("None · first commit")))
        .when(refs.length > 0, e => e.child(fact("Refs", h_flex().min_w(0).flex_wrap().gap(4).children(refs.slice(0, 12).map(r => pill(r, r.startsWith("tag: ") ? t.ansi3 : t.accent)))))),
      v_flex().gap(2)
        .child(h_flex().pb(4).gap(8).items_center().text_size(11)
          .child(div().flex_1().font_semibold().text_color(t.dim).child(detail ? `${detail.totalFiles} ${detail.totalFiles === 1 ? "file" : "files"} changed` : "Changed files"))
          .when(Boolean(detail), e => e.child(div().text_color(t.ansi2).child(`+${detail.additions}`)).child(div().text_color(t.ansi1).child(`−${detail.deletions}`))))
        .when(this.codewalker === false && !this.where.on, e => e.child(div().pb(4).text_size(11).text_color(t.muted).child("Install the Codewalker mod to see this diff.")))
        .when(commit.parents?.length > 1, e => e.child(div().pb(4).text_size(11).text_color(t.muted).child(`Compared with first parent ${commit.parents[0].slice(0, 7)}.`)))
        .when(this.detailLoading, e => e.child(secondary("Reading changed files…")))
        .when(Boolean(detail) && !files.length, e => e.child(secondary("No file changes.")))
        .children(files.map((file, i) => this.fileRow(file, i)))
        .when(Boolean(detail) && detail.totalFiles > files.length, e => e.child(div().pt(4).child(secondary(`Showing ${files.length} of ${detail.totalFiles} files.`)))),
    ];
  }
  fileRow(file, i) {
    const t = theme(), slash = file.path.lastIndexOf("/");
    const name = file.path.slice(slash + 1), folder = slash > 0 ? file.path.slice(0, slash) : "";
    const color = { A: t.ansi2, D: t.ansi1, R: t.accent, C: t.accent }[file.status] || t.muted;
    return h_flex().id(`file-${i}`).h(24).min_w(0).gap(8).items_center().text_size(12).tooltip(file.path)
      .child(div().w(10).flex_none().font_family(settings().font_family).text_size(11).text_color(color).child(file.status))
      // The file name leads; its folder trails, dim, and truncates first.
      .child(h_flex().flex_1().min_w(0).gap(6).items_baseline()
        .child(div().min_w(0).flex_none().max_w("70%").truncate().text_color(file.status === "D" ? t.muted : t.foreground).child(name))
        .when(Boolean(folder), e => e.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(folder))))
      .child(h_flex().flex_none().gap(6).text_size(11)
        .when(file.binary, e => e.child(div().text_color(t.dim).child("binary")))
        .when(!file.binary, e => e.child(div().text_color(file.additions ? t.ansi2 : t.dim).child(`+${file.additions}`)).child(div().text_color(file.deletions ? t.ansi1 : t.dim).child(`−${file.deletions}`))));
  }
  goToCommit(index, cx) {
    const commit = this.data?.commits?.[index];
    if (!commit) return;
    this.cursor = commit.hash;
    this.scroll.commits.scroll_to_item(index, "center");
    this.select(commit, "commit", cx);
  }
  // Left-aligned rows read as a list of results, not a stack of buttons.
  checkRow(check, i) {
    const t = theme(), url = /^https:\/\//.test(check.url || "") ? check.url : null;
    const state = String(check.state || "").toLowerCase().replace(/_/g, " ");
    return Button.new(`check-${i}`).w_full().h(26).px(6).mx(-6).rounded(5).text_size(12).text_color(t.foreground)
      .when(Boolean(url), e => e.cursor_pointer().hover(s => s.bg(t.hover)).tooltip("Open check on GitHub"))
      .disabled(!url).accessibility_label(`${check.name}, ${state}`).on_mouse_down("left", stop)
      .on_click((_event, cx) => { if (url) cx.open_url(url); })
      .child(h_flex().w_full().min_w(0).gap(8).items_center()
        .child(div().size(6).flex_none().rounded_full().bg(checkColor(checksSummary([check]).kind)))
        .child(div().flex_1().min_w(0).truncate().child(check.name))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(state)));
  }
  confirmation() {
    const { action, snapshot } = this.pending;
    const title = action.kind === "push" ? `${snapshot.upstream ? "Push" : "Publish"} ${snapshot.branch}?` : action.kind === "pull" ? `Pull into ${snapshot.branch}?` : action.kind === "pr" ? `Check out PR #${action.pr.number}?` : `Switch to ${action.branch.name}?`;
    const explanation = action.kind === "push" ? `Destination: ${action.remote} → ${action.target.replace(/^refs\/heads\//, "")}. No force push.`
      : action.kind === "pull" ? `From ${snapshot.upstream}. Fast-forward only; local changes are never stashed automatically.`
      : "This changes the current checkout for every terminal using it. Commit or stash local changes first.";
    return v_flex().flex_none().px(14).pt(12).pb(14).gap(12).bg(theme().surface).border_t(1).border_color(theme().border)
      .child(v_flex().gap(4)
        .child(div().font_semibold().text_size(13).child(title))
        .child(div().text_size(12).text_color(theme().muted).child(explanation))
        .child(secondary(`${snapshot.root}${this.where.on ? ` · ${this.where.on}` : ""}`)))
      .child(h_flex().gap(8).justify_end().child(button("cancel-action", "Cancel", cx => { this.pending = null; cx.notify(); }, { enabled: !this.busy }))
        .child(button("confirm-action", this.busy ? "Working…" : "Confirm", cx => this.perform(cx), { primary: true, enabled: !this.busy })));
  }
  // Restores an expanded panel that was hidden or now shows another mod. Never
  // mutates during render: the check is cheap, the commands run in a task.
  scheduleReconcile(cx) {
    if (this.reconciling || !expander.needsReconcile()) return;
    this.reconciling = true;
    cx.spawn(async cx => {
      const result = expander.reconcile();
      this.reconciling = false;
      if (result === "timeout") this.operationError = "The panel did not restore. Use Restore to try again.";
      if (result === "restored") stopExpansionTimer();
      else if (result && result !== "waiting") afterExpansion(cx);
      if (result && result !== "waiting") cx.notify();
    });
  }
  // Expansion state for this copy, or null: only a docked copy whose own dock matches the layout.
  expansion() {
    const p = props() || {};
    if (this.toolbar || p.overlay || !p.dock || !dockState(p.dock)) return null;
    const state = expander.state(p.dock);
    return state.supported ? state : null;
  }
  toggleExpansion(cx) {
    const state = this.expansion(), dock = (props() || {}).dock;
    if (!state || state.restoring || (!state.expanded && state.reason === "at-max")) return;
    const error = state.expanded ? expander.restore() : expander.expand(dock, MOD);
    if (error) this.operationError = error;
    afterExpansion(cx);
    cx.notify();
  }
  expandButton(p, cx) {
    const state = this.expansion();
    if (!state) return null;
    const max = state.max ? `${state.max}px` : "";
    const tooltip = state.expanded ? (state.error ? "Restore did not finish · try again" : "Restore panel width")
      : state.reason === "at-max" ? `Already at the layout's maximum width (${max})`
      : state.mode === "max" ? `Widen to the layout's maximum width (${max})` : "Expand to fill the workspace";
    return button("expand", "", cx => this.toggleExpansion(cx), { icon: state.expanded ? "minimize-2" : "maximize-2", tooltip, enabled: !state.restoring && state.reason !== "at-max", selected: state.expanded });
  }
  render(cx) {
    const t = theme(), p = props() || {};
    this.scheduleReconcile(cx);
    if (this.toolbar) {
      const on = dockState(p.dock)?.on;
      return h_flex().size_full().pr(10).justify_end().items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(h_flex().id("open-git").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
          .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).cursor_pointer()
          .hover(s => s.bg(t.hover)).tooltip(on ? "Close Git" : "Git · commits and pull requests").accessibility_label(on ? "Close Git" : "Open Git")
          .on_mouse_down("left", stop).on_click((_e, cx) => openGit(p.dock, cx))
          .child(svg(icon("github")).size(14)).child("Git"));
    }
    if (!this.fixed && !this.busy) {
      const where = currentLocation(this.where);
      if (contextKey(where) !== contextKey(this.where)) this.enter(where, cx);
      else this.where = where;
    }
    const data = this.data, width = this.width, wide = width >= 760;
    const expand = this.expandButton(p, cx);
    const showFilter = this.mode === "prs" && (!this.prError || this.prError.kind === "other");
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
          const rows = id === "commits" ? this.data?.commits || [] : id === "prs" ? this.prs || [] : this.branchRows();
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
      // Row 1: what is listed, plus Refresh. Esc closes an overlay; the toolbar Git button closes the dock.
      .child(bar(42)
        .child(segments("mode", [["history", "History"], ["prs", "Pull requests", this.prs && !this.prError ? `${this.prs.length}${this.prMore ? "+" : ""}` : null]], this.mode, (mode, cx) => this.setMode(mode, cx)))
        .child(div().flex_1())
        .when(showFilter && width >= PR_FILTER_INLINE, e => e.child(this.prFilter()))
        .child(button("refresh", "", cx => this.refresh(cx, true), { icon: "refresh", tooltip: "Refresh Git and pull requests", enabled: !this.loading && !this.prLoading && !this.busy }))
        // Expand/Restore is the last control in the row, as in Codewalker.
        .when(Boolean(expand), e => e.child(expand)))
      // Row 2: the branch (switcher; repository in its tooltip) and what can move. The branch picker turns this row into its search field.
      .child(this.mode === "branches" ? this.branchSearch() : bar(40)
        .child(h_flex().flex_1().min_w(0).gap(8).items_center()
          .when(Boolean(data?.head || data?.branch), e => e.child(this.branchSwitch()))
          .when(this.mode === "history" && Boolean(data?.head), e => e.child(button("scope", width < 400 ? "All" : "All branches", cx => { this.all = !this.all; this.limit = 150; this.refresh(cx); cx.notify(); },
            { small: true, selected: this.all, enabled: !this.loading && !this.busy, tooltip: this.all ? "Showing all branches · show only the current branch" : "Showing the current branch · show all branches" })))
          .when(!(data?.head || data?.branch), e => e.child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(this.loading ? "Reading repository…" : repo ? `${repo} · no commits` : "No checkout"))))
        .when(Boolean(data?.upstream), e => e.child(button("pull", data.behind ? String(data.behind) : "", cx => this.ask({ kind: "pull" }, cx), { icon: "pull", enabled: canSync, tooltip: `Pull${data.behind ? ` ${data.behind} incoming ${data.behind === 1 ? "commit" : "commits"}` : ""} from ${data.upstream} · fast-forward only` })))
        .when(Boolean(data?.branch), e => e.child(data.upstream
          ? button("push", data.ahead ? String(data.ahead) : "", cx => this.ask({ kind: "push" }, cx), { icon: "push", enabled: canSync && data.remotes.length > 0, tooltip: data.ahead ? `Push ${data.ahead} outgoing ${data.ahead === 1 ? "commit" : "commits"} to ${data.upstream}` : `Push to ${data.upstream}` })
          : button("push", "Publish", cx => this.ask({ kind: "push" }, cx), { icon: "push", enabled: canSync && data.remotes.length > 0, tooltip: data.remotes.length ? "Publish branch and set its upstream" : "Add a remote before publishing" }))))
      .when(showFilter && width < PR_FILTER_INLINE, e => e.child(bar(40).child(this.prFilter())))
      .when(Boolean(error), e => e.child(h_flex().flex_none().px(14).py(7).gap(8).items_start().bg(tint(t.blocked, "1a")).border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).pt(2).text_size(12).text_color(t.blocked).child(error))
        .child(button("dismiss-error", "", cx => { this.operationError = null; this.error = null; cx.notify(); }, { small: true, ghost: true, icon: "x", tooltip: "Dismiss" }))))
      .when(Boolean(this.notice), e => e.child(div().flex_none().px(14).py(7).text_size(11).text_color(t.ansi2).border_b(1).border_color(t.border).child(this.notice)))
      .child((wide ? h_flex().items_stretch() : v_flex()).flex_1().min_h(0).min_w(0)
        .child(this.mode === "prs" ? this.prList() : this.mode === "branches" ? this.branches() : this.history())
        .when(Boolean(this.selected) && this.mode !== "branches", e => e.child(this.detailView(wide))))
      .when(Boolean(this.pending), e => e.child(this.confirmation()))
      .child(h_flex().h(26).flex_none().px(14).gap(8).items_center().border_t(1).border_color(t.border).text_size(11)
        .child(div().size(6).flex_none().rounded_full().bg(error ? t.blocked : this.loading || this.busy ? t.working : t.idle))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(this.busy ? "Git operation in progress…" : this.loading && !data ? "Reading repository…" : `${sync}${data?.upstream ? ` · ${data.ahead} ahead · ${data.behind} behind` : data ? " · not published" : ""}${this.where.on ? ` · ${this.where.on}` : ""}`))
        .when(Boolean(this.prLoading), e => e.child(secondary("Reading PRs…"))));
  }
}
