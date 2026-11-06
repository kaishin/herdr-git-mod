import { READ, PR_FIELDS, COMMIT_FILES, parseLog, parseStatus, parseBranches, parseCommitMeta, parseCommitFiles, slimPR, sameHead, actionArgs } from "./model.js";

export class GitClient {
  constructor(exec, where) { this.exec = exec; this.where = { ...where }; this.writing = false; }
  async raw(program, args) { return this.exec(program, args, this.where); }
  async command(program, args) {
    let result;
    try { result = await this.raw(program, args); }
    catch (error) { throw new Error(`${program} could not finish: ${error.message || error}`); }
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || `${program} exited ${result.code}`).trim().slice(0, 1800));
    return result.stdout;
  }
  git(args) { return this.command("git", [...READ, ...args]); }
  async status() { return parseStatus(await this.git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"])); }
  async snapshot(limit = 150, all = true) {
    const root = (await this.git(["rev-parse", "--show-toplevel"])).trim();
    const status = await this.status();
    const [log, branches, remotes] = await Promise.all([
      status.head ? this.git(["log", "--topo-order", "--decorate=full", `--max-count=${limit + 1}`, "--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x00", ...(all ? ["--branches", "--remotes", "--tags", "HEAD"] : ["HEAD"]), "--"]) : "",
      this.git(["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(worktreepath)%00%(symref)", "refs/heads", "refs/remotes"]),
      this.git(["remote"]),
    ]);
    // Don't display a mixed snapshot if another terminal changed HEAD while reading.
    const after = await this.status();
    if (!sameHead(status, after)) throw new Error("The checkout changed while loading. Refresh to read it again.");
    const commits = parseLog(log);
    let upstreamRemote = "", upstreamRef = "";
    if (status.branch && status.upstream) {
      const upstream = await this.git(["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", `refs/heads/${status.branch}`]);
      [upstreamRemote, upstreamRef] = upstream.trim().split("\0");
    }
    return { ...after, root, commits: commits.slice(0, limit), more: commits.length > limit, branches: parseBranches(branches), remotes: remotes.trim().split("\n").filter(Boolean), upstreamRemote, upstreamRef };
  }
  async prs(filter = "all", limit = 50) {
    const args = ["pr", "list", "--state", "open", "--limit", String(limit + 1), "--json", PR_FIELDS];
    if (filter === "mine") args.push("--author", "@me");
    if (filter === "review") args.push("--search", "review-requested:@me");
    const rows = JSON.parse(await this.command("gh", args));
    return { rows: rows.slice(0, limit).map(slimPR), more: rows.length > limit };
  }
  async commit(hash) {
    if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new Error("Invalid commit ID.");
    // Structured facts, not a diff; Codewalker remains the review surface.
    const meta = parseCommitMeta(await this.git(["show", "-s", "--decorate=full", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%D%x1f%B", "--end-of-options", hash, "--"]));
    // Merges compare with their first parent, as `git log --first-parent` would show them.
    const range = meta.parents.length ? [meta.parents[0], hash] : ["--root", hash];
    const tree = ["diff-tree", "-r", "--no-commit-id", "--no-renames", "--no-ext-diff", "-z"];
    const [numstat, status] = await Promise.all([this.git([...tree, "--numstat", ...range]), this.git([...tree, "--name-status", ...range])]);
    const files = parseCommitFiles(numstat, status);
    return { ...meta, files: files.slice(0, COMMIT_FILES), totalFiles: files.length,
      additions: files.reduce((n, f) => n + (f.additions || 0), 0), deletions: files.reduce((n, f) => n + (f.deletions || 0), 0) };
  }
  async pr(number) {
    if (!Number.isInteger(number) || number < 1) throw new Error("Invalid pull request.");
    const pr = JSON.parse(await this.command("gh", ["pr", "view", String(number), "--json", `${PR_FIELDS},body,mergeable,mergeStateStatus,additions,deletions,changedFiles`]));
    return { ...slimPR(pr), body: (pr.body || "").slice(0, 12000), bodyTruncated: (pr.body || "").length > 12000, checksList: (pr.statusCheckRollup || []).map(c => ({ name: c.name || c.context || "Check", state: c.conclusion || c.state || c.status || "UNKNOWN", url: c.detailsUrl || c.targetUrl })) };
  }
  async mutate(action, snapshot) {
    if (this.writing) throw new Error("Another Git operation is still running.");
    this.writing = true;
    try {
      const root = (await this.git(["rev-parse", "--show-toplevel"])).trim();
      if (root !== snapshot.root) throw new Error("The repository changed. Refresh and try again.");
      let command = "git", args;
      if (action.kind === "pr") {
        const latest = await this.pr(action.pr.number);
        if (latest.headRefOid !== action.pr.headRefOid || latest.headRefName !== action.pr.headRefName) throw new Error("The PR branch changed. Refresh it before checking out.");
        command = "gh"; args = ["pr", "checkout", String(action.pr.number)];
      } else {
        args = actionArgs(action, snapshot);
        if (action.kind === "branch") {
          const hash = (await this.git(["rev-parse", "--verify", "--end-of-options", action.branch.ref])).trim();
          if (hash !== action.branch.hash) throw new Error("The target branch moved. Refresh before switching.");
        }
      }
      const now = await this.status();
      if (!sameHead(now, snapshot)) throw new Error("HEAD, branch, or upstream changed. Refresh and try again.");
      if (action.kind !== "push" && now.dirty) throw new Error("Commit or stash your local changes first. Nothing was changed.");
      if (now.conflicts) throw new Error("Resolve the conflicts before continuing.");
      // An exec timeout may leave an uncertain outcome; never automatically retry a write.
      try { return await this.command(command, args); }
      catch (error) { throw new Error(`${error.message}\nCheck the repository before retrying; the operation may have partly completed.`); }
    } finally { this.writing = false; }
  }
}
