# Design

This is an Operate surface inside Codewalker’s existing visual system, not a new visual identity. The reference is `../herdr-codewalker-mod/mods/Codewalker/main.js`.

- Host theme and UI font throughout; no private palette. ANSI colors distinguish graph lanes and factual check states.
- 10px outer card radius, 1px theme border; omit the card when the host supplies a frame.
- 42px repository header; 40px mode/action rows; 36px section headers; 26px status footer. Horizontal padding 14px, control gaps 8px (10px in the header).
- 13px panel text; 12px semibold section/row headings; 11px metadata; 10px compact status labels. Monospace is reserved for object IDs and Git output.
- Codewalker’s 26px controls, 22px small controls, 6px corners, 5px icon/label gaps. Labelled ghost buttons keep a border. Segmented controls use a 26px outer frame and 20px segments.
- Commit rows: 48px, two lines, 12px lane spacing, 8px nodes. Native paths show topology rather than text approximations. HEAD is a ring. No decorative animation.
- PR rows: 76px, title first, branch/author second, CI/review state third. Do not collapse these facts into an unsupported “ready to merge” claim.
- Details stack below the list at narrow widths and sit beside it at 760px+. Long refs and subjects truncate without displacing actions. High-fanout graphs scroll horizontally rather than dropping lanes.
- Branch switches and network writes use an inline confirmation, with repository and destination. There is no surprise modal and no silent checkout.
- List event handlers belong on `on_item_click`, never inside a deferred row renderer. Virtual lists fill a relative parent, with an overlaid scrollbar; a flex-only native list can collapse even when its initial description passes.

Visual evidence: `docs/history.png` and `docs/pull-requests.png`, native captures of the synthetic fixtures in `scripts/check-ui.py`. The real Shizen panel follows the same component implementation. Both were inspected; no browser rendering is involved.
