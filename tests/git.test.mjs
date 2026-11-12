import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitClient } from "../mods/Git/client.js";
import { checksSummary, parseStatus, prProblem, githubWebUrl, parseRemotes, repositoryUrl, hasGitHubRemote, noPullRequests, remotesKey, prLocation, parsePRComments, threadAnchor, PR_COMMENTS_QUERY, imagesAsText } from "../mods/Git/model.js";
import { layoutLanes } from "../mods/Git/lanes.js";
import { codewalkerInstalled, reviewTarget, commitReviewProblem, commitReviewArgs } from "../mods/Git/codewalker.js";

const execute = promisify(execFile);
async function exec(program, args, { cwd } = {}) {
  try { const r = await execute(program, args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 8 * 1024 * 1024 }); return { code: 0, ...r }; }
  catch (e) { if (typeof e.code !== "number") throw e; return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-git-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, "checkout with spaces");
  async function git(...args) { const r = await exec("git", args, { cwd }); assert.equal(r.code, 0, r.stderr); return r.stdout.trim(); }
  const init = await exec("git", ["init", "-b", "main", cwd]); assert.equal(init.code, 0);
  await git("config", "user.name", "Git Mod Test"); await git("config", "user.email", "git-test@example.invalid");
  const client = new GitClient(exec, { cwd });
  async function commit(name, body = name) { await writeFile(join(cwd, name), body); await git("add", "--", name); await git("commit", "-m", name); return git("rev-parse", "HEAD"); }
  return { dir, cwd, git, client, commit };
}

test("unborn, detached and merged histories retain real parent topology and branch identities", async t => {
  const f = await fixture(t);
  const unborn = await f.client.snapshot();
  assert.equal(unborn.branch, "main"); assert.equal(unborn.head, null); assert.deepEqual(unborn.commits, []);
  const base = await f.commit("base");
  await f.git("switch", "-c", "feature/日本語"); const feature = await f.commit("feature");
  await f.git("switch", "main"); const main = await f.commit("main");
  await f.git("merge", "--no-ff", "feature/日本語", "-m", "Merge feature");
  const data = await f.client.snapshot();
  assert.deepEqual(data.commits[0].parents, [main, feature]);
  assert.equal(data.commits.at(-1).hash, base);
  assert.ok(data.branches.some(b => b.name === "feature/日本語"));
  const graph = layoutLanes(data.commits);
  assert.ok(graph.width >= 2);
  // Every rail that leaves one row must arrive at the next, even when lanes converge.
  for (let i = 1; i < graph.rows.length; i++) {
    const previous = graph.rows[i - 1].segments.filter(s => s[3] === 1).map(s => s[2]).sort();
    const incoming = graph.rows[i].segments.filter(s => s[1] === 0).map(s => s[0]).sort();
    assert.deepEqual(incoming, [...new Set(previous)]);
  }
  await f.git("switch", "--detach", base);
  const detached = await f.client.snapshot(); assert.equal(detached.branch, null); assert.equal(detached.head, base);
});

test("branch switching refuses dirty, stale and occupied checkouts, then switches safely", async t => {
  const f = await fixture(t); await f.commit("base"); await f.git("branch", "topic");
  const snapshot = await f.client.snapshot(), branch = snapshot.branches.find(b => b.name === "topic");
  await writeFile(join(f.cwd, "untracked"), "keep me");
  await assert.rejects(f.client.mutate({ kind: "branch", branch }, snapshot), /Commit or stash/);
  assert.equal(await f.git("branch", "--show-current"), "main");
  await rm(join(f.cwd, "untracked")); await f.commit("changed-head");
  await assert.rejects(f.client.mutate({ kind: "branch", branch }, snapshot), /changed/);
  await f.git("worktree", "add", join(f.dir, "other checkout"), "topic");
  const occupied = await f.client.snapshot();
  await assert.rejects(f.client.mutate({ kind: "branch", branch: occupied.branches.find(b => b.name === "topic") }, occupied), /checked out in/);
  await f.git("worktree", "remove", join(f.dir, "other checkout"));
  const fresh = await f.client.snapshot();
  await f.client.mutate({ kind: "branch", branch: fresh.branches.find(b => b.name === "topic") }, fresh);
  assert.equal(await f.git("branch", "--show-current"), "topic");
});

test("publish, push and fast-forward pull work against a local remote; divergence is not forced", async t => {
  const f = await fixture(t); await f.commit("base");
  const remote = join(f.dir, "remote.git"); assert.equal((await exec("git", ["init", "--bare", remote])).code, 0);
  await f.git("remote", "add", "origin", remote);
  const publish = { kind: "push", remote: "origin", target: "refs/heads/main" };
  await f.git("config", "push.followTags", "true");
  await f.git("tag", "-a", "private-test-tag", "-m", "Do not publish this tag");
  await f.client.mutate(publish, await f.client.snapshot());
  assert.equal(await f.git("ls-remote", "--tags", "origin"), "", "Only the confirmed branch is pushed, not configured follow-tags");
  let snapshot = await f.client.snapshot();
  assert.equal(snapshot.upstream, "origin/main"); assert.equal(snapshot.upstreamRemote, "origin"); assert.equal(snapshot.upstreamRef, "refs/heads/main");
  await f.commit("outgoing"); snapshot = await f.client.snapshot(); assert.equal(snapshot.ahead, 1);
  await f.client.mutate(publish, snapshot);
  const peer = join(f.dir, "peer");
  assert.equal((await exec("git", ["clone", "-b", "main", remote, peer])).code, 0);
  async function peerGit(...args) { const r = await exec("git", ["-c", "user.name=Peer", "-c", "user.email=peer@example.invalid", ...args], { cwd: peer }); assert.equal(r.code, 0, r.stderr); }
  await writeFile(join(peer, "incoming"), "new"); await peerGit("add", "."); await peerGit("commit", "-m", "incoming"); await peerGit("push");
  await f.client.mutate({ kind: "pull" }, await f.client.snapshot());
  assert.equal(await f.git("log", "-1", "--format=%s"), "incoming");
  await f.commit("local-divergence"); const local = await f.git("rev-parse", "HEAD");
  await writeFile(join(peer, "remote-divergence"), "other"); await peerGit("add", "."); await peerGit("commit", "-m", "remote divergence"); await peerGit("push");
  await assert.rejects(f.client.mutate({ kind: "pull" }, await f.client.snapshot()), /fast-forward|diverg/i);
  assert.equal(await f.git("rev-parse", "HEAD"), local);
  await assert.rejects(f.client.mutate(publish, await f.client.snapshot()), /rejected/);
  await f.git("fetch"); assert.notEqual(await f.git("rev-parse", "origin/main"), local);
});

test("remote tracking checkout preserves slash-containing branch names", async t => {
  const f = await fixture(t); await f.commit("base");
  const remote = join(f.dir, "remote.git"); await exec("git", ["init", "--bare", remote]);
  await f.git("remote", "add", "origin", remote); await f.git("push", "origin", "HEAD:refs/heads/team/feature"); await f.git("fetch", "origin");
  const snapshot = await f.client.snapshot();
  const branch = snapshot.branches.find(b => b.name === "origin/team/feature");
  await f.client.mutate({ kind: "branch", branch }, snapshot);
  const after = await f.client.snapshot();
  assert.equal(after.branch, "team/feature"); assert.equal(after.upstream, "origin/team/feature");
});

test("Git status handles renamed paths with newlines without counting the source path", () => {
  const result = parseStatus("# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +3 -2\0" +
    "2 R. N... 100644 100644 100644 a b R100 renamed\nname\0? old name\0? untracked\0u UU N... conflict\0");
  assert.equal(result.dirty, 3); assert.equal(result.conflicts, 1); assert.equal(result.ahead, 3); assert.equal(result.behind, 2);
});

test("CI summaries never call missing, skipped or unknown checks passed", () => {
  assert.equal(checksSummary([]).kind, "none");
  assert.equal(checksSummary([{ status: "COMPLETED", conclusion: "SKIPPED" }]).kind, "skipped");
  assert.equal(checksSummary([{ status: "COMPLETED", conclusion: "FUTURE_STATE" }]).kind, "unknown");
  assert.equal(checksSummary([{ state: "SUCCESS" }, { status: "IN_PROGRESS" }]).kind, "pending");
  assert.equal(checksSummary([{ state: "SUCCESS" }, { conclusion: "FAILURE" }]).kind, "failed");
});

test("PR checkout revalidates the head and refuses dirty files before executing gh checkout", async t => {
  const f = await fixture(t); await f.commit("base");
  let checkouts = 0, head = "a".repeat(40);
  const pr = { number: 7, headRefOid: head, headRefName: "feature" };
  const client = new GitClient(async (program, args, where) => {
    if (program !== "gh") return exec(program, args, where);
    if (args[1] === "view") return { code: 0, stdout: JSON.stringify({ ...pr, headRefOid: head }), stderr: "" };
    if (args[1] === "checkout") { checkouts++; return { code: 0, stdout: "", stderr: "" }; }
    throw new Error("unexpected command");
  }, { cwd: f.cwd });
  const snapshot = await client.snapshot();
  head = "b".repeat(40);
  await assert.rejects(client.mutate({ kind: "pr", pr }, snapshot), /PR branch changed/);
  head = pr.headRefOid;
  await writeFile(join(f.cwd, "unsaved"), "keep");
  await assert.rejects(client.mutate({ kind: "pr", pr }, snapshot), /Commit or stash/);
  assert.equal(checkouts, 0);
  await rm(join(f.cwd, "unsaved")); await client.mutate({ kind: "pr", pr }, snapshot);
  assert.equal(checkouts, 1);
});

test("pull request failures name one actionable cause", () => {
  assert.equal(prProblem("", [], null).kind, "no-remote");
  assert.equal(prProblem("no git remotes found", ["origin"], null).kind, "no-remote");
  // gh's non-GitHub message also mentions `gh auth login`; it must not read as a sign-in problem.
  assert.equal(prProblem("none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`", ["origin"], null).kind, "not-github");
  assert.equal(prProblem("X No default remote repository has been set. please run `gh repo set-default`", ["origin", "upstream"], null).kind, "no-default");
  const auth = prProblem("To get started with GitHub CLI, please run:  gh auth login", ["origin"], "vps");
  assert.equal(auth.kind, "auth"); assert.match(auth.detail, /on vps/);
  assert.equal(prProblem("gh could not finish: spawn gh ENOENT", ["origin"], null).kind, "no-gh");
  const other = prProblem("HTTP 502: Bad Gateway", ["origin"], null);
  assert.equal(other.kind, "other"); assert.equal(other.raw, "HTTP 502: Bad Gateway");
});

test("commit details are structured facts, including root, binary, deleted and merge commits", async t => {
  const f = await fixture(t);
  const root = await f.commit("a.txt", "one\ntwo\n");
  const first = await f.client.commit(root);
  assert.deepEqual(first.parents, []);
  assert.equal(first.subject, "a.txt"); assert.equal(first.body, "");
  assert.deepEqual(first.files, [{ path: "a.txt", status: "A", additions: 2, deletions: 0, binary: false }]);

  await writeFile(join(f.cwd, "a.txt"), "one\n"); await writeFile(join(f.cwd, "image.bin"), Buffer.from([0, 1, 2, 0, 255]));
  await f.git("add", "--", "a.txt", "image.bin");
  await f.git("commit", "-m", "Subject line", "-m", "Body paragraph with\x1f a separator.");
  const second = await f.client.commit(await f.git("rev-parse", "HEAD"));
  assert.equal(second.subject, "Subject line"); assert.equal(second.body, "Body paragraph with\x1f a separator.");
  assert.deepEqual(second.files.map(x => [x.path, x.status, x.additions, x.deletions, x.binary]), [["a.txt", "M", 0, 1, false], ["image.bin", "A", null, null, true]]);
  assert.equal(second.deletions, 1);

  await f.git("switch", "-c", "side"); await f.git("rm", "-q", "--", "image.bin"); await f.git("commit", "-m", "Drop image");
  await f.git("switch", "main"); await f.commit("b.txt");
  await f.git("merge", "--no-ff", "side", "-m", "Merge side");
  const merge = await f.client.commit(await f.git("rev-parse", "HEAD"));
  assert.equal(merge.parents.length, 2);
  // A merge lists what it brought in relative to its first parent.
  assert.deepEqual(merge.files.map(x => [x.path, x.status]), [["image.bin", "D"]]);
  assert.ok(merge.refs.some(r => r.includes("refs/heads/main")));
});

test("commit diffs open in Codewalker only when it is installed, local, and beside a live pane", async () => {
  const home = "/apps/herdr home/";
  const reads = [];
  const files = present => async path => { reads.push(path); return present.some(name => path.endsWith(`/mods/Codewalker/${name}`)) ? "source" : null; };
  assert.equal(await codewalkerInstalled(files(["main.js", "backend.py"]), home), true);
  assert.deepEqual(reads.slice(0, 2), ["/apps/herdr home/mods/Codewalker/main.js", "/apps/herdr home/mods/Codewalker/backend.py"]);
  assert.equal(await codewalkerInstalled(files([]), home), false, "absent");
  assert.equal(await codewalkerInstalled(files(["main.js"]), home), false, "backend missing");
  assert.equal(await codewalkerInstalled(async () => { throw new Error("denied"); }, home), false, "read failure");
  assert.equal(await codewalkerInstalled(files(["main.js", "backend.py"]), null), false, "no app home");

  const panes = [{ pane: "p1", tab: "t1", focused: false }, { pane: "p2", tab: "t1", focused: true }, { pane: "p3", tab: "t2", focused: false }];
  assert.equal(reviewTarget(panes, { pane: "p2", tab: "t1" }, "p1").pane, "p1", "the followed pane wins over focus");
  assert.equal(reviewTarget(panes, { pane: "p3", tab: "t2" }, "gone").pane, "p3", "a closed pane falls back to focus");
  assert.equal(reviewTarget(panes, { pane: null, tab: "t1" }, null).pane, "p2", "a focused layout block falls back to its tab");
  assert.equal(reviewTarget([], { pane: null, tab: "t1" }, "p1"), null);

  const hash = "a".repeat(40), ok = { installed: true, on: null, root: "/repo", hash, pane: "p1" };
  assert.equal(commitReviewProblem(ok), null);
  assert.match(commitReviewProblem({ ...ok, installed: false }), /Install the Codewalker mod/);
  assert.match(commitReviewProblem({ ...ok, installed: null }), /Checking/);
  assert.match(commitReviewProblem({ ...ok, on: "studio" }), /local checkouts/, "remote checkouts never route to a same-path local folder");
  assert.match(commitReviewProblem({ ...ok, on: "studio", installed: false }), /local checkouts/);
  assert.match(commitReviewProblem({ ...ok, root: "" }), /root/);
  assert.match(commitReviewProblem({ ...ok, hash: "abc1234" }), /full ID/);
  assert.match(commitReviewProblem({ ...ok, pane: null }), /No pane/);
  assert.deepEqual(commitReviewArgs(ok), { direction: "right", pane: "p1", mod: "Codewalker", props: { framed: true, folder: "/repo", scope: "commit", commit: hash } });
});

test("the GitHub button opens the repository page of a GitHub remote only", async t => {
  for (const [remote, url] of [
    ["git@github.com:kaishin/herdr-git-mod.git", "https://github.com/kaishin/herdr-git-mod"],
    ["https://github.com/kaishin/herdr-git-mod.git", "https://github.com/kaishin/herdr-git-mod"],
    ["https://user:token@github.com/kaishin/herdr-git-mod", "https://github.com/kaishin/herdr-git-mod"],
    ["ssh://git@ssh.github.com:443/kaishin/herdr-git-mod.git", "https://github.com/kaishin/herdr-git-mod"],
    ["git@github.example.com:team/app.git", "https://github.example.com/team/app"],
    ["git@gitlab.com:team/app.git", null],
    ["/srv/git/app.git", null],
    ["https://github.com/kaishin", null],
  ]) assert.equal(githubWebUrl(remote), url, remote);
  assert.deepEqual(parseRemotes("origin\tgit@github.com:a/b.git (fetch)\norigin\tgit@github.com:a/b.git (push)\nfork\thttps://github.com/c/b (fetch)\nfork\thttps://github.com/c/b (push)\n"),
    { names: ["origin", "fork"], urls: { origin: "git@github.com:a/b.git", fork: "https://github.com/c/b" } });
  // The upstream's remote wins, then origin, then a lone remote.
  const data = { remotes: ["origin", "fork"], remoteUrls: { origin: "git@github.com:a/b.git", fork: "https://github.com/c/b" } };
  assert.equal(repositoryUrl(data), "https://github.com/a/b");
  assert.equal(repositoryUrl({ ...data, upstreamRemote: "fork" }), "https://github.com/c/b");
  assert.equal(repositoryUrl({ remotes: ["fork"], remoteUrls: { fork: "https://github.com/c/b" } }), "https://github.com/c/b");
  assert.equal(repositoryUrl({ remotes: ["a", "b"], remoteUrls: { a: "git@github.com:x/y", b: "git@github.com:z/y" } }), null);
  // A real checkout reports its remote URLs.
  const { git, client, commit } = await fixture(t);
  await commit("one.txt");
  await git("remote", "add", "origin", "git@github.com:example/synthetic.git");
  const snapshot = await client.snapshot();
  assert.deepEqual(snapshot.remotes, ["origin"]);
  assert.equal(repositoryUrl(snapshot), "https://github.com/example/synthetic");
});

test("pull requests are hidden only for checkouts that cannot have them", () => {
  const gh = { remotes: ["origin"], remoteUrls: { origin: "git@github.com:a/b.git" } };
  const lab = { remotes: ["origin"], remoteUrls: { origin: "git@gitlab.com:a/b.git" } };
  const corp = { remotes: ["origin"], remoteUrls: { origin: "git@git.corp.example:a/b.git" } };
  assert.equal(hasGitHubRemote(gh), true);
  assert.equal(hasGitHubRemote(lab), false);
  assert.equal(noPullRequests({ remotes: [] }, null), true, "no remote: nothing to show");
  assert.equal(noPullRequests(gh, null), false);
  // A GitHub remote keeps the tab, so gh's own problem (sign in, install) is shown there.
  assert.equal(noPullRequests(gh, prProblem("To get started with GitHub CLI, please run: gh auth login", gh.remotes)), false);
  assert.equal(noPullRequests(gh, prProblem("gh could not finish: not found", gh.remotes)), false);
  // Without one, any gh failure hides it; gh's "not a GitHub host" hides it whatever the name.
  assert.equal(noPullRequests(lab, prProblem("gh could not finish: not found", lab.remotes)), true);
  assert.equal(noPullRequests(corp, prProblem("none of the git remotes configured for this repository point to a known GitHub host", corp.remotes)), true);
  assert.notEqual(remotesKey(gh), remotesKey(lab), "a remote change asks gh again");
});

test("PR comments merge reviews, conversation and inline threads, newest first", () => {
  const bot = { __typename: "Bot", login: "codecov" }, sam = { __typename: "User", login: "sam" };
  const parsed = parsePRComments({
    reviews: { pageInfo: { hasPreviousPage: false }, nodes: [
      { author: sam, body: "", state: "APPROVED", submittedAt: "2026-01-05T00:00:00Z", url: "https://github.com/o/r/pull/1#r1" },
      { author: sam, body: "", state: "COMMENTED", submittedAt: "2026-01-04T00:00:00Z" },
      { author: sam, body: "Draft", state: "PENDING", submittedAt: null },
    ] },
    comments: { pageInfo: { hasPreviousPage: true }, nodes: [
      { author: null, body: "From a deleted account", createdAt: "2026-01-01T00:00:00Z" },
      { author: bot, body: "Coverage 80%", createdAt: "2026-01-02T00:00:00Z" },
      { author: bot, body: "Coverage 81%", createdAt: "2026-01-03T00:00:00Z" },
      { author: sam, body: "   ", createdAt: "2026-01-06T00:00:00Z" },
    ] },
    reviewThreads: { pageInfo: { hasPreviousPage: false }, nodes: [
      { isResolved: true, isOutdated: false, path: "a.js", line: 12, startLine: 10, diffSide: "RIGHT",
        comments: { totalCount: 3, nodes: [{ author: sam, body: "Off by one.", createdAt: "2026-01-07T00:00:00Z" }, { author: bot, body: "Fixed?", createdAt: "2026-01-08T00:00:00Z" }] } },
    ] },
  });
  assert.deepEqual(parsed.items.map(c => [c.kind, c.author, c.body]), [
    ["thread", "sam", "Off by one."], ["review", "sam", ""], ["comment", "codecov", "Coverage 81%"], ["comment", "ghost", "From a deleted account"],
  ]);
  const [thread] = parsed.items;
  assert.equal(thread.anchor, "a.js:10-12"); assert.equal(thread.resolved, true);
  assert.deepEqual(thread.replies.map(r => [r.author, r.bot]), [["codecov", true]], "Bots keep every thread reply");
  assert.equal(parsed.truncated, true); assert.equal(parsed.repliesTruncated, true);
  // A LEFT thread names the old file's lines; a thread without lines names its file.
  assert.equal(threadAnchor({ path: "b.js", diffSide: "LEFT", line: 50, originalLine: 4 }), "b.js:4");
  assert.equal(threadAnchor({ path: "c.js" }), "c.js");
});

test("PR comments ask the PR's own repository through gh api, without a shell", async () => {
  assert.deepEqual(prLocation("https://GitHub.example.com/team/app.js/pull/42"), { host: "github.example.com", owner: "team", name: "app.js", number: 42 });
  assert.equal(prLocation("https://github.com/o/r/issues/4"), null);
  const calls = [];
  const client = new GitClient(async (program, args) => {
    calls.push([program, ...args]);
    return { code: 0, stderr: "", stdout: JSON.stringify({ data: { repository: { pullRequest: { comments: { nodes: [{ author: { login: "a" }, body: "Hi", createdAt: "2026-01-01T00:00:00Z" }] } } } } }) };
  }, { cwd: "/x" });
  const result = await client.prComments("https://github.com/o/r/pull/7");
  assert.equal(result.items[0].body, "Hi");
  assert.deepEqual(calls[0], ["gh", "api", "graphql", "--hostname", "github.com", "-f", `query=${PR_COMMENTS_QUERY}`, "-f", "o=o", "-f", "n=r", "-F", "num=7"]);
  await assert.rejects(client.prComments("not a url"), /no GitHub address/);
  const failing = new GitClient(async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ data: { repository: null }, errors: [{ message: "Could not resolve to a Repository" }] }) }), { cwd: "/x" });
  await assert.rejects(failing.prComments("https://github.com/o/r/pull/7"), /Could not resolve/);
});

test("images become linked alt text, because remote images do not load", () => {
  const camo = "https://camo.githubusercontent.com/f2c1/6874";
  assert.equal(imagesAsText(`<img src="${camo}" alt="P2 Badge" data-canonical-src="https://img.shields.io/badge/P2-yellow?style=flat" style="max-width: 100%;"> Fix this.`), `[P2 Badge](<${camo}>) Fix this.`);
  assert.equal(imagesAsText(`<a href="https://ci.example/run/1"><img src="${camo}" alt='Build'></a>`), "[Build](<https://ci.example/run/1>)");
  assert.equal(imagesAsText("[![Coverage 81%](https://x.test/c.svg)](https://x.test/report)"), "[Coverage 81%](<https://x.test/report>)");
  assert.equal(imagesAsText('![](https://x.test/shot.png "Screenshot")'), "[image](<https://x.test/shot.png>)");
  assert.equal(imagesAsText("![Inline](data:image/png;base64,AAAA)"), "Inline", "Only web links stay links");
  assert.equal(imagesAsText('<img alt="a [b] c" src="https://x.test/i">'), "[a \\[b\\] c](<https://x.test/i>)");
  const fenced = "```md\n![kept](https://x.test/k.png)\n```\n![gone](https://x.test/g.png)";
  assert.equal(imagesAsText(fenced), "```md\n![kept](https://x.test/k.png)\n```\n[gone](<https://x.test/g.png>)");
  assert.equal(parsePRComments({ comments: { nodes: [{ author: { login: "c" }, body: "<img alt=\"P1\" src=\"https://x.test/p1\">", createdAt: "2026-01-01T00:00:00Z" }] } }).items[0].body, "[P1](<https://x.test/p1>)");
});
