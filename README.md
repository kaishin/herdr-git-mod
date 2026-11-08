# Git for Herdr

A native Git panel for the [Herdr](https://herdr.dev) desktop app. It shows the commit graph of the focused terminal's checkout, with pull requests and branch switching one click away. Every checkout, pull and push asks first.

![Git: commit graph and commit details](preview.png)

## What it does

- Draws the commit graph with colored lanes, merges, HEAD, branch and tag labels. Load older commits, or limit history to the current branch.
- Lists open PRs for **This repo**, **Mine** or **To review**. Shows CI and review decisions separately; missing checks never count as passing.
- Opens commit summaries (message, parents, refs, changed files) and PR descriptions and checks. **Check out** switches to a PR with `gh pr checkout`, including forks.
- **View diff** opens the selected commit in [Codewalker](#dependencies)'s commit review, in a new pane to the right of the followed pane. Local checkouts only.
- Switches local branches, or creates a tracking branch from a remote ref. Branches held by other worktrees are marked and cannot be switched here.
- Pulls fast-forward only. Pushes only the named branch, without force, follow-tags or recursive submodule pushes. Unpublished branches offer **Publish**.
- Follows the focused terminal's checkout, including remote spaces. A `folder` prop pins a copy to one checkout.

![Pull requests with synthetic preview data](docs/pull-requests.png)

All screenshots are native Herdr captures of synthetic fixtures (`scripts/check-ui.py --preview`), not real repository or GitHub data.

## Dependencies

| Needs | Why |
|---|---|
| A recent Herdr desktop app with `gpui-base` virtual lists and `PathBuilder` | The panel UI |
| `git` | History, status, branches, and every write |
| GitHub CLI `gh`, signed in (`gh auth login`) | Pull requests and PR checkout. Without it, history and sync still work, and the PR tab says what is missing. |
| Codewalker mod (optional) | **View diff**. Without it, the button is hidden and the details say to install it. |

Remote spaces need `git` and `gh` on that machine. The mod needs no Node runtime, and nothing is downloaded.

## Access

Herdr mods are trusted code, not sandboxed. This mod:

- **Runs programs:** `git` and `gh`, through Herdr's `exec`, with argument lists and no shell. Git hooks and credential helpers can run as Git normally runs them.
- **Reaches the network:** `gh` contacts the configured GitHub host to read PRs. Pull, push and PR checkout contact the configured Git remotes. Links open in the browser only on a click.
- **Reads outside its folder:** the checkout's Git metadata, and `mods/Codewalker/main.js` and `backend.py` in the app home (only to detect Codewalker; it never runs or installs it).
- **Writes:** only through a Git operation you confirm: branch switch, PR checkout, pull or push. It stores no tokens and no files. The toolbar copy adds its dock child to the shared `workspace.panels` list.
- **Changes the window:** View diff splits a pane. The toolbar button shows or hides its docked panel, or opens a window overlay. It never changes layouts, settings or keys, and it launches no agents.

## Install

```sh
git clone https://github.com/kaishin/herdr-git-mod.git
cd herdr-git-mod
python3 scripts/install.py
herdr-app check ~/.config/herdr-app/mods/Git
herdr-app do mod.open --name Git
```

The installer honors `HERDR_APP_HOME` and copies only `mods/Git/`. It **never writes layouts, settings or keybindings**. It refuses to replace a `mods/Git` folder that this checkout did not install. On macOS this includes a community mod named `git`, because the default file system ignores case. In that case, rename this mod first: rename the folder and change `MOD` in `mods/Git/ui.js`.

Without Python, copy `mods/Git/` to `~/.config/herdr-app/mods/Git/` yourself. Do not copy `RECIPE.md`, `preview.png`, `docs/` or `scripts/`.

### Update

```sh
git pull
python3 scripts/install.py
herdr-app check ~/.config/herdr-app/mods/Git
```

Herdr reloads the mod in place when its files change. The installer also removes files that the new version no longer has.

### Remove

Close any Git panels, remove `content: {"mod":"Git"}` from your layouts if you added it, then delete `~/.config/herdr-app/mods/Git`.

## Use

Open a standalone window without editing a layout:

```sh
herdr-app do mod.open --name Git
```

Or use `content: {"mod":"Git"}` in a personal layout, or open a pane with `pane.split` and `mod: "Git"`. No layout or keybinding ships with this package. Optional props:

| Prop | Meaning |
|---|---|
| `folder`, `on`, `pane` | Pin a checkout, its machine, and the pane a commit diff opens beside. Omit to follow focus. |
| `framed: true` | Omit the outer card border when the host already frames the pane. |
| `toolbar: true` | Render only the Git entry button. Without `dock`, it opens a standalone window. |
| `dock: {panel, stack, child}` | Host node IDs for a docked panel. Put the same prop on the toolbar copy and the panel copy. No layout names or IDs are hardcoded. |

Commands delivered to visible copies: `Git.history`, `Git.prs`, `Git.branches`, `Git.refresh`. In a focused list, Up and Down select rows, and Enter opens a row or asks to switch a branch. Escape closes the confirmation, then the details, then the branch picker.

## Write safety

Every checkout, pull and push asks for confirmation and names its checkout. On Confirm, the panel checks HEAD, branch, upstream and target again before it writes. Checkout and pull refuse local changes. Nothing is automatically stashed, reset, rebased or forced. Git also refuses occupied worktrees and conflicting updates.

Git has no transaction that spans the check and an external checkout process. Another terminal can still change the checkout after the check; Git's own locks and refusal rules are the final guard. A timeout or transport failure can leave a partial result, so inspect the repository before you retry. Writes are never retried automatically.

## Limits

- Remote refs and ahead/behind counts come from the last fetch. Refresh reads local state; it does not fetch. Pull fetches its upstream.
- History loads 150 commits at a time and PRs 50 at a time. Lists are virtualized. Commit details list up to 300 changed files. PR bodies are capped at 12,000 characters and checks at 80. GitHub has the complete PR.
- Local state is read every 15 seconds and PRs every 60 seconds while a docked panel is visible. Hidden docked panels do not poll. Standalone and pane copies without a `dock` prop poll at the same rate even when hidden.
- Herdr `exec` has a 30-second, 8 MiB limit. Large repositories or slow network operations can exceed it.
- No merge, rebase, reset, staging, commit creation, CI reruns or branch cleanup.

## Development

```sh
npm test                    # Behavior tests on real Git fixtures with temporary local remotes
python3 scripts/check-ui.py  # Native render descriptions of populated fixtures
herdr-app check mods/Git
```

Ten behavior tests cover DAG topology, unborn and detached checkouts, refusal for dirty, stale and occupied-worktree checkouts, tracking branches, publish, push, pull and divergence, status parsing, honest CI states, PR preflight, PR load-failure causes, commit details (root, binary, deleted, merge), and the Codewalker hand-off. Sixteen native checks cover virtual and eager rows, narrow and wide views, details, the missing-Codewalker state and confirmations. These checks do not prove pixel layout or pointer interaction. No real GitHub checkout, push or pull was tested.

### Preview image

`preview.png` (2560×1280: 1280×640 at 2×, black and dark-gray diagonal stripes behind the card) is composed from a kept native capture, `docs/preview-source.png`:

```sh
python3 scripts/check-ui.py --preview history --size 900x580   # opens an isolated, non-writing synthetic window
herdr-app shot /tmp/herdr-git-capture.png
# close the overlay, then:
python3 scripts/check-ui.py --clean-preview
python3 scripts/compose-preview.py --capture /tmp/herdr-git-capture.png --crop X,Y,W,H
```

`--crop` takes the preview window's pixel box in the capture. `python3 scripts/compose-preview.py` with no arguments composes again from the kept source. Provenance is in `docs/preview-source.json`. The preview mod creates no layout and makes no repository or network calls.

See [RECIPE.md](RECIPE.md), [design](DESIGN.md) and [source notes](docs/inspiration.md).

## License

[MIT](LICENSE). Third-party parts: `mods/Git/LICENSE-lanes` (MIT, lane layout) and `mods/Git/icons/LICENSE` (Lucide ISC and Feather MIT).
