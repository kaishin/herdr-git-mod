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
// `git remote -v`: names in order, with their fetch URLs.
export function parseRemotes(text) {
  const names = [], urls = {};
  for (const line of String(text || "").split("\n")) {
    const m = /^(\S+)\t(\S+) \((fetch|push)\)$/.exec(line.trim());
    if (!m) continue;
    if (!names.includes(m[1])) names.push(m[1]);
    if (m[3] === "fetch") urls[m[1]] = m[2];
  }
  return { names, urls };
}
// The https page of a GitHub remote (github.com or a host with "github" in its
// name), or null. Accepts scp-style, ssh:// and https:// remotes; drops credentials.
export function githubWebUrl(remote) {
  const text = String(remote || "").trim();
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git:\/\/|[^@/\s]+@)([^/:\s]+)(?::\d+)?[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(text);
  if (!m || !/github/i.test(m[1])) return null;
  const host = m[1].toLowerCase() === "ssh.github.com" ? "github.com" : m[1].toLowerCase();
  return `https://${host}/${m[2]}/${m[3]}`;
}
// Which remote "the repository" is: the upstream's, then origin, then the only one.
export function primaryRemote(data) {
  const names = data?.remotes || [];
  if (data?.upstreamRemote && names.includes(data.upstreamRemote)) return data.upstreamRemote;
  return names.includes("origin") ? "origin" : names.length === 1 ? names[0] : null;
}
export function repositoryUrl(data) {
  const remote = primaryRemote(data);
  return remote ? githubWebUrl(data.remoteUrls?.[remote]) : null;
}
// A remote whose host is named like GitHub. gh also knows Enterprise hosts by
// other names, so this is only a first guess until gh answers.
export function hasGitHubRemote(data) { return Object.values(data?.remoteUrls || {}).some(url => githubWebUrl(url)); }
export const remotesKey = data => JSON.stringify(data?.remoteUrls || {});
// After a failed `gh pr list`: true when this checkout has no pull requests to
// show at all, so the tab is hidden and gh is not asked again for these remotes.
export function noPullRequests(data, problem) {
  if (!data?.remotes?.length) return true;
  if (!problem) return false;
  return problem.kind === "not-github" || problem.kind === "no-remote" || !hasGitHubRemote(data);
}
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

// PR comments, read the way herdr-reviewr reads them: submitted reviews, conversation
// comments and inline review threads in one GraphQL query, newest first.
export const COMMENT_BODY = 6000;
export const PR_COMMENTS_QUERY = "query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){pullRequest(number:$num){"
  + "reviews(last:100){pageInfo{hasPreviousPage} nodes{author{__typename login} body state submittedAt url}} "
  + "comments(last:100){pageInfo{hasPreviousPage} nodes{author{__typename login} body createdAt url}} "
  + "reviewThreads(last:100){pageInfo{hasPreviousPage} nodes{isResolved isOutdated path line startLine originalLine originalStartLine diffSide "
  + "comments(first:50){totalCount nodes{author{__typename login} body createdAt url}}}}}}}";
// Host, owner, name and number from a PR's https URL, so gh asks the PR's own repository.
export function prLocation(url) {
  const m = /^https:\/\/([^/\s]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#]|$)/.exec(String(url || ""));
  return m ? { host: m[1].toLowerCase(), owner: m[2], name: m[3], number: Number(m[4]) } : null;
}
// Herdr's Markdown view leaves a blank gap for remote images, and a mod cannot fetch
// image bytes. Each image becomes its alt text, linked to where it pointed: the
// surrounding link if it had one, else the image itself. Code blocks stay as written.
const attr = (tag, name) => (new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag) || []).slice(1).find(v => v !== undefined) || "";
const linkText = alt => (String(alt).replace(/\s+/g, " ").trim() || "image").replace(/[[\]\\]/g, "\\$&");
const linkTo = (alt, url) => /^https?:\/\//i.test(url) ? `[${linkText(alt)}](<${url.replace(/[<>\s]/g, encodeURIComponent)}>)` : linkText(alt);
export function imagesAsText(markdown) {
  return String(markdown || "").split(/(^ {0,3}(?:```|~~~)[^\n]*\n[\s\S]*?(?:^ {0,3}(?:```|~~~)[ \t]*$|(?![\s\S])))/m).map((part, i) => i % 2 ? part : part
    .replace(/<a\s[^>]*>\s*(<img\b[^>]*>)\s*<\/a>/gi, (link, img) => linkTo(attr(img, "alt"), attr(link, "href") || attr(img, "src")))
    .replace(/<img\b[^>]*>/gi, img => linkTo(attr(img, "alt"), attr(img, "src")))
    .replace(/\[!\[([^\]]*)\]\(\s*<?[^)\s>]*>?(?:\s+"[^"]*")?\s*\)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g, (_m, alt, href) => linkTo(alt, href))
    .replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g, (_m, alt, src) => linkTo(alt, src))).join("");
}
// GraphQL gives bots their bare login with __typename Bot; REST adds "[bot]".
const person = author => ({ author: author?.login || "ghost", bot: author?.__typename === "Bot" || /\[bot\]$/.test(author?.login || "") });
const text = body => { const s = imagesAsText(String(body || "").trim()).trim(); return { body: s.slice(0, COMMENT_BODY), bodyTruncated: s.length > COMMENT_BODY }; };
// A thread's new-side range, else its original one; a LEFT thread always uses the original.
export function threadLines(t) {
  const pick = (start, end) => start == null && end == null ? null : { start: start ?? end, end: end ?? start };
  const original = pick(t.originalStartLine, t.originalLine);
  if (t.diffSide === "LEFT" && original) return original;
  return pick(t.startLine, t.line) || original;
}
export function threadAnchor(t) {
  const lines = threadLines(t);
  if (!lines) return t.path || "";
  const [lo, hi] = [Math.min(lines.start, lines.end), Math.max(lines.start, lines.end)];
  return `${t.path}:${lo === hi ? lo : `${lo}-${hi}`}`;
}
export function parsePRComments(pr) {
  const out = [], more = conn => Boolean(conn?.pageInfo?.hasPreviousPage);
  for (const r of pr?.reviews?.nodes || []) {
    // A pending review is the viewer's unsent draft. An empty comment-only review says nothing.
    if (!r || r.state === "PENDING" || (!String(r.body || "").trim() && !["APPROVED", "CHANGES_REQUESTED"].includes(r.state))) continue;
    out.push({ kind: "review", ...person(r.author), ...text(r.body), state: r.state, createdAt: r.submittedAt || "", url: r.url || "" });
  }
  for (const c of pr?.comments?.nodes || []) {
    if (!c || !String(c.body || "").trim()) continue;
    out.push({ kind: "comment", ...person(c.author), ...text(c.body), createdAt: c.createdAt || "", url: c.url || "" });
  }
  let repliesTruncated = false;
  for (const t of pr?.reviewThreads?.nodes || []) {
    const nodes = (t?.comments?.nodes || []).filter(n => n && String(n.body || "").trim());
    if (!nodes.length) continue;
    const [root, ...replies] = nodes;
    if ((t.comments.totalCount || 0) > t.comments.nodes.length) repliesTruncated = true;
    out.push({ kind: "thread", ...person(root.author), ...text(root.body), createdAt: root.createdAt || "", url: root.url || "",
      path: t.path || "", anchor: threadAnchor(t), resolved: Boolean(t.isResolved), outdated: Boolean(t.isOutdated),
      replies: replies.map(n => ({ ...person(n.author), ...text(n.body), createdAt: n.createdAt || "", url: n.url || "" })) });
  }
  // Bots repost status summaries: keep each bot's newest review or comment. Threads stay.
  const newest = new Map();
  for (const c of out) if (c.bot && c.kind !== "thread" && c.createdAt > (newest.get(c.author) || "")) newest.set(c.author, c.createdAt);
  const items = out.filter(c => !c.bot || c.kind === "thread" || (c.kind === "review" && !c.createdAt) || newest.get(c.author) === c.createdAt);
  items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return { items, truncated: more(pr?.reviews) || more(pr?.comments) || more(pr?.reviewThreads), repliesTruncated };
}
export function reviewStateLabel(state) {
  return { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", COMMENTED: "Reviewed", DISMISSED: "Dismissed" }[state] || "Reviewed";
}
