# Design

This is an Operate surface inside Codewalker’s existing visual system, not a new visual identity. The reference is `../herdr-codewalker-mod/mods/Codewalker/main.js`.

- Host theme and UI font throughout; no private palette. ANSI colors distinguish graph lanes and factual check states.
- 10px outer card radius, 1px theme border; omit the card when the host supplies a frame.
- Two header rows. Row 1 (42px): History/Pull requests, the mode's own control (All branches toggle, or the PR filter), Refresh, Close. Row 2 (40px): branch switcher (repository path in its tooltip), then Pull/Push with incoming/outgoing counts. Below 480px the PR filter takes a third row. The branch picker turns row 2 into its search field. No separate list-title row.
- 40px detail header carries the item's actions; 36px load-more rows; 26px status footer. Horizontal padding 14px, control gaps 8px (10px in the header).
- Every list shares one left edge: 14px gutter, a 13px icon or lane-0 column, 8px gap. PR and branch icons sit in their own column so the lines below the title align with it.
- 13px panel text; 12px semibold section/row headings; 11px metadata; 10px compact status labels. Monospace is reserved for object IDs and Git output.
- Codewalker’s 26px controls, 22px small controls, 6px corners, 5px icon/label gaps. Labelled ghost buttons keep a border. Segmented controls use a 26px outer frame and 20px segments.
- Commit rows: 48px, two lines, 12px lane spacing, lane 0 centered at 6px, 8px nodes. Ref labels drop `HEAD ->`; the ring marks HEAD. Native paths show topology rather than text approximations. HEAD is a ring. No decorative animation.
- PR rows: 76px, title first, branch/author second, CI/review state third (12px title, 11px lines below). PR details group title and size, then review and CI, then the description, then checks as left-aligned rows with a state dot. Do not collapse these facts into an unsupported “ready to merge” claim.
- Details stack below the list at narrow widths and sit beside it at 760px+. Long refs and subjects truncate without displacing actions. High-fanout graphs scroll horizontally rather than dropping lanes.
- Branch switches and network writes use an inline confirmation, with repository and destination. There is no surprise modal and no silent checkout.
- List event handlers belong on `on_item_click`, never inside a deferred row renderer. Virtual lists fill a relative parent, with an overlaid scrollbar; a flex-only native list can collapse even when its initial description passes.

Visual evidence: `docs/history.png` and `docs/pull-requests.png`, native captures of the synthetic fixtures in `scripts/check-ui.py`. The real Shizen panel follows the same component implementation. Both were inspected; no browser rendering is involved.
