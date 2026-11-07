// Opens a commit diff in Codewalker's public commit review. The helpers take Herdr's
// functions as arguments, so tests can run them without Herdr.
// Contract: Codewalker README, "Open a specific comparison from another mod".

const FILES = ["main.js", "backend.py"];

// True only when both Codewalker entry files are readable in the effective app home.
// Reads only; never installs or runs Codewalker.
export async function codewalkerInstalled(readTextFile, home) {
  if (typeof home !== "string" || !home) return false;
  const base = `${home.replace(/[\\/]+$/, "")}/mods/Codewalker`;
  try {
    const files = await Promise.all(FILES.map(name => readTextFile(`${base}/${name}`)));
    return files.every(text => typeof text === "string" && text.length > 0);
  } catch { return false; }
}

// A live pane to split: the pane this panel follows, then the focused pane,
// then a pane in the focused tab. Resolve it before any await.
export function reviewTarget(panes, focused, preferred) {
  const live = panes || [];
  return live.find(p => p.pane === preferred)
    || live.find(p => p.pane === focused?.pane)
    || live.find(p => p.tab === focused?.tab && p.focused)
    || live.find(p => p.tab === focused?.tab)
    || null;
}

// Why the diff cannot open, or null. `installed`: true, false, or null while checking.
export function commitReviewProblem({ installed, on, root, hash, pane }) {
  if (on) return "Commit diffs open only for local checkouts.";
  if (installed === null || installed === undefined) return "Checking for Codewalker…";
  if (!installed) return "Install the Codewalker mod to see commit diffs.";
  if (!/^(\/|[A-Za-z]:[\\/])/.test(root || "")) return "The checkout root is not known. Refresh and try again.";
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(hash || "")) return "This commit has no full ID.";
  if (!pane) return "No pane to open the diff beside. Open a terminal, then try again.";
  return null;
}

export function commitReviewArgs({ pane, root, hash }) {
  return { direction: "right", pane, mod: "Codewalker", props: { framed: true, folder: root, scope: "commit", commit: hash } };
}
