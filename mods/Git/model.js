export const READ = ["--no-optional-locks", "-c", "color.ui=false"];
export const COMMIT_FILES = 300;
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

// Turns a gh failure into one cause the person can act on. Order matters: gh's
// "not a GitHub host" message also mentions `gh auth login`.
export function prProblem(message, remotes, machine) {
  const text = String(message || "").trim(), where = machine ? `on ${machine}` : "on this computer";
  if (!remotes?.length || /no git remotes found/i.test(text)) return { kind: "no-remote", title: "This checkout has no remote", detail: "Pull requests come from GitHub. Add a GitHub remote, then refresh.", command: "git remote add origin <GitHub URL>", copy: "git remote add origin " };
  if (/none of the git remotes|known GitHub host/i.test(text)) return { kind: "not-github", title: "No GitHub remote", detail: `Remotes: ${remotes.join(", ")}. None points to GitHub, so there are no pull requests to show.` };
  if (/set-default|determine base repo|multiple remotes/i.test(text)) return { kind: "no-default", title: "Choose the repository for pull requests", detail: "This checkout has more than one GitHub remote. Set a default, then retry.", command: "gh repo set-default", retry: true };
  if (/gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i.test(text)) return { kind: "auth", title: "Sign in to GitHub CLI", detail: `GitHub CLI has no session ${where}. Sign in, then retry.`, command: "gh auth login", retry: true };
  if (/^gh could not finish:.*(not found|ENOENT|no such file|cannot find)/i.test(text)) return { kind: "no-gh", title: "GitHub CLI is not installed", detail: `Pull requests are read with gh. Install it ${where}, sign in with gh auth login, then retry.`, retry: true };
  return { kind: "other", title: "Couldn’t load pull requests", detail: "GitHub CLI returned this error:", raw: text || "No details.", retry: true };
}

// `git show -s` with unit-separated fields; the raw message (%B) is last so it may contain anything.
export function parseCommitMeta(text) {
  const [hash, parents, author, email, time, committer, committerTime, refs, ...message] = text.split("\x1f");
  const raw = message.join("\x1f").replace(/\s+$/, "");
  const [subject, ...rest] = raw.split("\n");
  const body = rest.join("\n").trim();
  return { hash: hash.trim(), parents: parents ? parents.split(" ").filter(Boolean) : [], author, email, time: Number(time), committer, committerTime: Number(committerTime),
    refs: (refs || "").split(", ").filter(Boolean), subject: subject || "", body: body.slice(0, 8000), bodyTruncated: body.length > 8000 };
}
// Pairs `diff-tree -z --numstat` with `--name-status`. Binary files report "-" counts.
export function parseCommitFiles(numstat, status) {
  const kinds = new Map(), parts = status.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) kinds.set(parts[i + 1], parts[i][0]);
  return numstat.split("\0").filter(Boolean).map(line => {
    const [added, deleted, ...path] = line.split("\t"), name = path.join("\t"), binary = added === "-";
    return { path: name, status: kinds.get(name) || "M", additions: binary ? null : Number(added), deletions: binary ? null : Number(deleted), binary };
  });
}
export function shortDate(time) {
  const d = new Date(time * 1000), pad = n => String(n).padStart(2, "0");
  return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
}
