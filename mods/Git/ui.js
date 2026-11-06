import { div, svg, PathBuilder } from "gpui-kit";
import { h_flex, v_flex, Button } from "gpui-base";
import { theme } from "herdr";
import { tint } from "./model.js";

export const stop = (_event, cx) => cx.stop_propagation();
export const icon = name => `mods/Git/icons/${name}.svg`;
export const ROW = 48;

// Codewalker's control family: 26px / 22px; labelled ghosts retain their edge.
export function button(id, label, action, o = {}) {
  const t = theme(), enabled = o.enabled !== false, size = o.small ? 22 : 26;
  const fg = !enabled ? t.dim : o.primary ? t.solid_foreground : o.selected ? t.foreground : t.muted;
  const bg = o.primary ? (enabled ? t.solid : t.raised) : o.selected ? t.selected : "#00000000";
  return Button.new(id).h(size).flex_none().rounded(6).text_size(o.small ? 11 : 12).text_color(fg).bg(bg)
    .when(Boolean(label), e => e.px(o.small ? 7 : 10)).when(!label, e => e.w(size))
    .when(Boolean(o.maxW), e => e.max_w(o.maxW))
    .when(!o.primary && (!o.ghost || Boolean(label)), e => e.border_1().border_color(t.border))
    .when(enabled, e => e.cursor_pointer().hover(s => s.bg(o.primary ? t.solid : t.hover).text_color(o.primary ? t.solid_foreground : t.foreground)))
    .when(Boolean(o.tooltip), e => e.tooltip(o.tooltip))
    .disabled(!enabled).accessibility_label(o.tooltip || label).on_mouse_down("left", stop)
    .on_click((_event, cx) => { if (enabled) action(cx); })
    .child(h_flex().min_w(0).gap(5).items_center().justify_center().text_color(fg)
      .when(Boolean(o.icon), e => e.child(svg(icon(o.icon)).size(o.small ? 12 : 13).flex_none()))
      .when(Boolean(label), e => e.child(div().min_w(0).truncate().child(label))));
}
export function segments(id, items, current, action) {
  const t = theme();
  return h_flex().flex_none().h(26).p(2).gap(2).items_center().rounded(7).bg(t.background).border_1().border_color(t.border)
    .children(items.map(([value, label]) => Button.new(`${id}-${value}`).h(20).px(8).rounded(5).text_size(12)
      .bg(value === current ? t.selected : "#00000000").text_color(value === current ? t.foreground : t.muted)
      .cursor_pointer().hover(s => s.bg(t.hover)).accessibility_label(label).on_mouse_down("left", stop)
      .on_click((_event, cx) => action(value, cx)).child(label)));
}
export const bar = (height = 36) => h_flex().h(height).flex_none().px(14).gap(8).items_center().border_b(1).border_color(theme().border);
export const secondary = text => div().min_w(0).truncate().text_size(11).text_color(theme().muted).child(text);
export function pill(text, color = theme().accent) {
  return div().flex_none().max_w(180).truncate().px(6).py(1).rounded(4).text_size(10).bg(tint(color)).text_color(color).child(text);
}
export function empty(title, detail) {
  return v_flex().px(22).py(28).gap(7).child(div().font_semibold().text_size(13).child(title))
    .child(div().text_size(12).text_color(theme().muted).child(detail));
}
// Lane 0 centers on a 13px icon column, so commit text shares the left edge of PR and branch rows.
const LANE = 12, FIRST = 6;
export const graphCellWidth = lanes => Math.max(13, FIRST * 2 + (lanes - 1) * LANE);
export function checkColor(kind) {
  const t = theme();
  return kind === "failed" ? t.ansi1 : kind === "pending" ? t.working : kind === "passed" ? t.ansi2 : t.muted;
}
export function graphCell(row, head, width) {
  const t = theme(), colors = [t.accent, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi4], paths = new Map();
  const x = lane => FIRST + lane * LANE, y = fraction => fraction * ROW;
  for (const [a, ya, b, yb, c] of row.segments) {
    const color = colors[c % colors.length];
    let path = (paths.get(color) || PathBuilder.stroke(1.5)).move_to(x(a), y(ya));
    if (a === b) path = path.line_to(x(b), y(yb));
    else { const mid = (y(ya) + y(yb)) / 2; path = path.cubic_bezier_to(x(b), y(yb), x(a), mid, x(b), mid); }
    paths.set(color, path);
  }
  const color = colors[row.lane % colors.length];
  return div().relative().flex_none().w(width).h(ROW).overflow_hidden()
    .children([...paths].map(([color, path]) => window.paint_path(path.build(), color).absolute().top(0).left(0).size_full()))
    .child(div().absolute().left(x(row.lane) - 4).top(ROW / 2 - 4).size(8).rounded(4).bg(head ? t.background : color)
      .when(head, e => e.border(2).border_color(color)));
}
