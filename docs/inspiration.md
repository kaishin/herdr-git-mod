# Source notes

All six requested repositories were shallow-cloned for inspection into `/tmp/herdr-git-inspo.h5BksR`. No downloaded installers, background agents, or external mod code were executed.

| Source | Inspected revision | Idea carried into this mod |
|---|---|---|
| [rabeeh-ta/herdr-git-graph](https://github.com/rabeeh-ta/herdr-git-graph) | `4a9cd1ef79915234a56ba0031945b0b82973585c` | Stable topology lanes; native Bézier rails; a ring for HEAD; progressively loaded history. `mods/Git/lanes.js` is reused under MIT; its license ships in `LICENSE-lanes`. |
| [werlang/herdr-git-graph](https://github.com/werlang/herdr-git-graph) | `9dd0d49c72859b8e9cf22cc2ff0eee2057a4dfa9` | Worktree-aware branch controls, safe option boundaries, theme-derived lane colors. No source copied. |
| [jjangsky/herdr-pr-flow](https://github.com/jjangsky/herdr-pr-flow) | `37bdf7342e110b0b3f505c300dd8f3b0cc875af3` | Separate CI facts from review decisions, and check the PR head again before acting. Missing, skipped and unknown checks are not shown as passing. No source copied. |
| [mrolafsson/herdr-github/app](https://github.com/mrolafsson/herdr-github/tree/main/app) | `206a3dd922083de6e8edd5cd823518d7f586f47d` | This repo / Mine / Review requested scopes; list-to-detail navigation; branch and author context. Its binary provisioning and agent launches are deliberately not included. No source copied. |
| [cybertron288/herdr-mods/ci-dash](https://github.com/cybertron288/herdr-mods/tree/main/ci-dash) | `34e7c3348e954fd0a1147b846898db8c3e37e526` | Use existing `gh` authentication and machine-aware `exec`; show errors rather than interpreting failed commands as empty results. No source copied. |
| [jslowack/herdr-ranch/herdr-ranch-prs](https://github.com/jslowack/herdr-ranch/tree/main/herdr-ranch-prs) | `8d71664d3ab98aefe414923a5ed745c4c652b834` | Keep list state small by reducing CI rollups, then load PR bodies/check details only on selection. No source copied. |

The visual authority is the neighboring Codewalker mod, not these examples. Header, section, button, spacing and typography conventions follow it. Existing Lucide branch/refresh/close/check/folder icons are carried with their ISC license; the GitHub, PR, push and pull outlines are authored locally in the same stroke family.

## Deliberate omissions

No auto-installers, AI commit generation, agents, new workspaces, CI dispatch, merge queue controls, destructive branch operations, or layout assumptions. The task is history, pull requests, checkout, and sync—not another full Git client.
