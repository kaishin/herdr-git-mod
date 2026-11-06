export const READ = ["--no-optional-locks", "-c", "color.ui=false"];
export const PR_FIELDS = "number,title,url,author,headRefName,headRefOid,baseRefName,isDraft,isCrossRepository,reviewDecision,updatedAt,statusCheckRollup";

export function parseLog(text) {
  // NUL separates records; a subject can contain tabs or our unit separator.
  return text.split("\0").map(s => s.replace(/^\n/, "")).filter(Boolean).map(line => {
    const [hash, parents, author, time, refs, ...subject] = line.split("\x1f");
    return { hash, parents: parents ? parents.split(" ") : [], author, time: Number(time), refs: (refs || "").split(", ").filter(Boolean), subject: subject.join("\x1f") };
  }).filter(c => /^[a-f0-9]{40,64}$/.test(c.hash));
}

export function parseStatus(text) {
  const out = { head: null, branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0, conflicts: 0 };
  const fields = text.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const line = fields[i];
    if (line.startsWith("# branch.oid ")) out.head = line.slice(13) === "(initial)" ? null : line.slice(13);
    else if (line.startsWith("# branch.head ")) out.branch = line.slice(14) === "(detached)" ? null : line.slice(14);
    else if (line.startsWith("# branch.upstream ")) out.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line); if (m) { out.ahead = +m[1]; out.behind = +m[2]; }
    } else if (/^[12u?] /.test(line)) { out.dirty++; if (line[0] === "u") out.conflicts++; if (line[0] === "2") i++; }
  }
  return out;
}

export function parseBranches(text) {
  return text.trim().split("\n").filter(Boolean).map(line => {
    const [ref, hash, upstream, worktree, symref] = line.split("\0");
    const remote = ref.startsWith("refs/remotes/");
    return { ref, hash, upstream, worktree, symref, remote, name: ref.replace(/^refs\/(heads|remotes)\//, "") };
  }).filter(b => !b.symref);
}

export function checksSummary(checks = []) {
  const counts = { passed: 0, failed: 0, pending: 0, skipped: 0, unknown: 0 };
  for (const c of checks || []) {
    const state = String(c.conclusion || c.state || c.status || "").toUpperCase();
    if (state === "SUCCESS") counts.passed++;
    else if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(state)) counts.failed++;
    else if (["NEUTRAL", "SKIPPED"].includes(state)) counts.skipped++;
    else if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"].includes(state)) counts.pending++;
    else counts.unknown++;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const kind = !total ? "none" : counts.failed ? "failed" : counts.pending ? "pending" : counts.unknown ? "unknown" : counts.passed ? "passed" : "skipped";
  const label = kind === "none" ? "No checks" : kind === "failed" ? `${counts.failed} failed` : kind === "pending" ? `${counts.pending} running` : kind === "unknown" ? "Checks unknown" : kind === "skipped" ? "Checks skipped" : `${counts.passed} passed`;
  return { ...counts, total, kind, label };
}

export function slimPR(pr) {
  const { statusCheckRollup, ...rest } = pr;
  return { ...rest, checks: checksSummary(statusCheckRollup) };
}
export function reviewLabel(pr) {
  return pr.isDraft ? "Draft" : ({ APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required" }[pr.reviewDecision] || "Not reviewed");
}
export function ago(time) {
  const seconds = Math.max(0, Date.now() / 1000 - (typeof time === "number" ? time : Date.parse(time) / 1000));
  if (!Number.isFinite(seconds)) return "";
  return seconds < 60 ? "now" : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`;
}
export function tint(color, alpha = "26") { return /^#[a-f\d]{6}/i.test(color) ? color.slice(0, 7) + alpha : color; }
// HEAD is drawn as a ring on the graph, so "HEAD -> main" reads as "main".
export function refLabel(ref) { return ref.replace(/^HEAD -> /, "").replace(/refs\/(heads|remotes|tags)\//g, ""); }
export function sameHead(a, b) { return a.head === b.head && a.branch === b.branch && a.upstream === b.upstream; }
export function contextKey(where) { return JSON.stringify([where?.cwd || "", where?.on || null]); }

// Pins a repository operation to the snapshot the person confirmed. No shell interpolation.
export function actionArgs(action, snapshot) {
  if (action.kind === "branch") {
    const b = action.branch;
    if (!b?.ref?.startsWith(b.remote ? "refs/remotes/" : "refs/heads/")) throw new Error("Invalid branch reference.");
    if (b.worktree && b.worktree !== snapshot.root) throw new Error(`This branch is checked out in ${b.worktree}. Open that checkout instead.`);
    return b.remote ? ["switch", "--track", "--", b.ref] : ["switch", "--no-guess", "--", b.name];
  }
  if (action.kind === "pull") {
    if (!snapshot.upstream) throw new Error("No upstream. Publish this branch first.");
    return ["-c", "merge.autoStash=false", "-c", "rebase.autoStash=false", "pull", "--ff-only", "--no-rebase"];
  }
  if (action.kind === "push") {
    if (!snapshot.branch || !snapshot.head) throw new Error("Check out a branch with a commit before pushing.");
    if (!action.remote || action.remote.startsWith("-")) throw new Error("Choose a remote before pushing.");
    if (!action.target || !action.target.startsWith("refs/heads/")) throw new Error("Invalid push destination.");
    return ["push", "--no-follow-tags", "--recurse-submodules=no", ...(snapshot.upstream ? [] : ["--set-upstream"]), "--", action.remote, `refs/heads/${snapshot.branch}:${action.target}`];
  }
  throw new Error("Unknown Git action.");
}
