#!/usr/bin/env python3
"""Exercise populated native descriptions, including deferred rows, without network or Git writes.

--preview installs an isolated synthetic mod, opens it as a window, and leaves it
for a screenshot. Run --clean-preview afterward. It never writes a layout.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
HOME = Path(os.environ.get("HERDR_APP_HOME", "~/.config/herdr-app")).expanduser()
PREVIEW = HOME / "mods/Git-Development-Preview"
FIXTURE = '''import Git from "./view.js";
import { v_flex } from "gpui-base";
import { layoutLanes } from "./lanes.js";
import { slimPR } from "./model.js";
const hash = n => String(n).repeat(40);
const commits = [
  {hash:hash(1),parents:[hash(2),hash(3)],subject:"Merge pull request #42: preserve branch context",author:"Alex",time:Date.now()/1000-1800,refs:["HEAD -> refs/heads/main","refs/remotes/origin/main"]},
  {hash:hash(2),parents:[hash(4)],subject:"Keep the active checkout when focus moves",author:"Sam",time:Date.now()/1000-3600,refs:[]},
  {hash:hash(3),parents:[hash(5)],subject:"Refuse stale branch switches",author:"Alex",time:Date.now()/1000-7200,refs:["refs/heads/fix/context"]},
  {hash:hash(4),parents:[hash(6)],subject:"Add keyboard navigation to pull requests",author:"Sam",time:Date.now()/1000-9000,refs:[]},
  {hash:hash(5),parents:[hash(6)],subject:"Validate checkout before a Git operation",author:"Alex",time:Date.now()/1000-10000,refs:[]},
  {hash:hash(6),parents:[hash(7)],subject:"Show review decisions separately from CI",author:"River",time:Date.now()/1000-14000,refs:["tag: refs/tags/v0.2.0"]},
  {hash:hash(7),parents:[],subject:"Introduce the Git panel",author:"River",time:Date.now()/1000-16000,refs:[]},
];
const prs = [
  {number:43,title:"Keep branch switching tied to the checkout",author:{login:"alex"},headRefName:"fix/context",headRefOid:hash(3),baseRefName:"main",reviewDecision:"APPROVED",statusCheckRollup:[{conclusion:"SUCCESS"},{conclusion:"SUCCESS"}]},
  {number:44,title:"Add a compact commit inspector",author:{login:"sam"},headRefName:"feature/commit-details",headRefOid:hash(4),baseRefName:"main",reviewDecision:"REVIEW_REQUIRED",statusCheckRollup:[{status:"IN_PROGRESS"},{conclusion:"SUCCESS"}]},
  {number:45,title:"Handle linked worktrees without guessing",author:{login:"river"},headRefName:"fix/worktrees",headRefOid:hash(5),baseRefName:"main",reviewDecision:"CHANGES_REQUESTED",statusCheckRollup:[{conclusion:"FAILURE"}]},
  {number:46,title:"Explore history search",author:{login:"alex"},headRefName:"experiment/search",headRefOid:hash(6),baseRefName:"main",isDraft:true,statusCheckRollup:[]},
].map(p=>slimPR({...p,url:"https://github.com/example/synthetic/pull/"+p.number}));
export default class Fixture extends Git {
  // No production I/O. Fixture data never comes from or changes a user's repository.
  enter() {}
  refresh() {}
  loadPRs() {}
  perform() {}
  visible() { return false; }
  // A click in the preview selects without reading Git, and View diff opens nothing.
  select(item, kind, cx) { this.selected={item,kind}; this.detail=null; cx.notify(); }
  openCommitDiff() {}
  init(p, cx) {
    super.init(p,cx);
    this.fixed=true;
    this.where={cwd:"/synthetic/git-panel",on:null};
    this.width=WIDTH; this.height=HEIGHT;
    this.data={root:this.where.cwd,head:hash(1),branch:"main",upstream:"origin/main",upstreamRemote:"origin",upstreamRef:"refs/heads/main",ahead:2,behind:1,dirty:0,conflicts:0,remotes:["origin"],commits,more:true,
      branches:[{ref:"refs/heads/main",name:"main",hash:hash(1),upstream:"origin/main"},{ref:"refs/heads/fix/context",name:"fix/context",hash:hash(3)},{ref:"refs/heads/fix/worktrees",name:"fix/worktrees",hash:hash(5),worktree:"/synthetic/other-checkout"},{ref:"refs/remotes/origin/feature/commit-details",name:"origin/feature/commit-details",hash:hash(4),remote:true}]};
    this.graph=layoutLanes(commits); this.prs=prs;
    this.notice="Synthetic preview · no repository operations";
    this.mode="MODE";
    EXTRA
  }
  EAGER
}
'''

# --preview opens with a populated selection, so a capture needs no pointer or key input.
PREVIEW_STATE = {
    "history": 'this.codewalker=true; this.selected={kind:"commit",item:commits[0]}; this.detail={...commits[0],email:"alex@example.invalid",committer:"Alex",committerTime:commits[0].time,body:"Keep repository operations attached to the checkout that was confirmed, even when focus moves to another terminal.",bodyTruncated:false,files:[{path:"mods/Git/main.js",status:"M",additions:184,deletions:69,binary:false},{path:"mods/Git/model.js",status:"M",additions:3,deletions:1,binary:false},{path:"tests/git.test.mjs",status:"A",additions:41,deletions:0,binary:false},{path:"docs/history.png",status:"M",additions:null,deletions:null,binary:true}],totalFiles:4,additions:228,deletions:70};',
    "prs": 'this.selected={kind:"pr",item:prs[0]}; this.detail={...prs[0],body:"Keep repository operations attached to the checkout that was confirmed.\\n\\n- Refuse local changes before switching.\\n- Reject a stale HEAD.",bodyTruncated:false,changedFiles:3,additions:42,deletions:8,checksList:[{name:"Unit tests",state:"SUCCESS",url:"https://github.com/example/synthetic"},{name:"Native UI",state:"SUCCESS",url:"https://github.com/example/synthetic"}]};',
    "branches": "",
}


def write_fixture(destination, mode, width, extra="", eager=False, height=720):
    destination.mkdir(parents=True, exist_ok=True)
    for file in (ROOT / "mods/Git").glob("*.js"):
        shutil.copy2(file, destination / ("view.js" if file.name == "main.js" else file.name))
    (destination / "mod.json").write_text(f'{{"place":"none","title":"Git · synthetic preview","overlay":{{"kind":"window","width":{width},"height":{height}}}}}\n')
    # `check` does not enter deferred list rows. Eager rendering exercises those
    # same render callbacks through native controls and PathBuilder, with no stub UI.
    method = 'list(id,rows,height,render) { return v_flex().flex_1().children(rows.map((row,i)=>render(row,i))); }' if eager else ""
    text = FIXTURE.replace("WIDTH", str(width)).replace("HEIGHT", str(height)).replace("MODE", mode).replace("EXTRA", extra).replace("EAGER", method)
    (destination / "main.js").write_text(text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", choices=["history", "prs", "branches"])
    parser.add_argument("--size", default="1100x720", help="preview window WIDTHxHEIGHT")
    parser.add_argument("--clean-preview", action="store_true")
    args = parser.parse_args()
    if args.clean_preview:
        if PREVIEW.exists() and (PREVIEW / ".development-fixture").exists():
            shutil.rmtree(PREVIEW)
        return
    if args.preview:
        if PREVIEW.exists() and not (PREVIEW / ".development-fixture").exists():
            raise SystemExit(f"Refusing to overwrite {PREVIEW}")
        width, height = (int(n) for n in args.size.split("x"))
        write_fixture(PREVIEW, args.preview, width, PREVIEW_STATE[args.preview], height=height)
        (PREVIEW / ".development-fixture").write_text(str(ROOT))
        subprocess.run(["herdr-app", "check", str(PREVIEW)], check=True)
        subprocess.run(["herdr-app", "do", "mod.open", "--name", PREVIEW.name], check=True)
        print("Synthetic preview opened; close its overlay before --clean-preview.")
        return
    with tempfile.TemporaryDirectory(prefix="herdr-git-native-") as temp:
        destination = Path(temp) / "mod"
        for mode, width, extra in [
            ("history", 368, ""),
            ("history", 1100, 'this.selected={kind:"commit",item:commits[0]}; this.detail={...commits[0],email:"alex@example.invalid",committer:"Alex",committerTime:commits[0].time,body:"Keep the confirmed checkout.",bodyTruncated:false,files:[{path:"mods/Git/main.js",status:"M",additions:12,deletions:4,binary:false},{path:"docs/history.png",status:"M",additions:null,deletions:null,binary:true}],totalFiles:2,additions:12,deletions:4};'),
            ("prs", 368, ""),
            ("prs", 1100, 'this.selected={kind:"pr",item:prs[0]}; this.detail={...prs[0],body:"Synthetic **PR description**.",changedFiles:3,additions:42,deletions:8,checksList:[{name:"Unit tests",state:"SUCCESS",url:"https://github.com/example/synthetic"}]};'),
            ("branches", 280, ""),
            ("history", 368, 'this.pending={action:{kind:"push",remote:"origin",target:"refs/heads/main"},snapshot:this.data};'),
            ("history", 1100, 'this.codewalker=false; this.selected={kind:"commit",item:commits[1]};'),
            ("history", 1100, 'this.codewalker=true; this.selected={kind:"commit",item:commits[1]};'),
            # Docked expand states. Only expansion() is replaced; the button and its tooltip are the real ones.
            ("history", 368, 'this.expansion=()=>({supported:true,expanded:false,restoring:false,mode:"max",max:900,reason:null,error:null});'),
            ("history", 368, 'this.expansion=()=>({supported:true,expanded:true,restoring:false,mode:"max",max:900,reason:null,error:null});'),
        ]:
            for eager in (False, True):
                write_fixture(destination, mode, width, extra, eager)
                result = subprocess.run(["herdr-app", "check", str(destination), "--print-spec"], capture_output=True, text=True)
                if result.returncode or "WARN" in result.stderr:
                    raise SystemExit(result.stdout + result.stderr)
                if not eager:
                    virtual = next(line for line in result.stdout.splitlines() if "v_virtual_list " in line)
                    assert ".size_full" in virtual and ":on_item_click(fn)" in virtual, "The native list must fill its parent and own row events"
                    scrollbar = next(line for line in result.stdout.splitlines() if 'Scrollbar "' in line)
                    assert ".absolute" in scrollbar and ".inset_0" in scrollbar, "The scrollbar must overlay, not take the list's width"
                # Native descriptions must contain the populated graph/PR controls
                # when deferred rows are made eager, rather than passing on an empty state.
                if eager and mode == "history":
                    assert "path stroke" in result.stdout, "Graph paths were not rendered"
                if "this.codewalker=false" in extra:
                    assert "Install the Codewalker mod" in result.stdout, "Missing Codewalker must be explained"
                    assert 'Button "open-diff"' not in result.stdout, "View diff must be hidden without Codewalker"
                elif "this.codewalker=true" in extra:
                    assert 'Button "open-diff"' in result.stdout, "View diff must be offered for a commit"
                if "expansion=" in extra:
                    lines = result.stdout.splitlines()
                    at = lambda name: next(i for i, line in enumerate(lines) if f'Button "{name}"' in line)
                    assert at("refresh") < at("expand"), "Expand must be the last control after Refresh"
                if "expanded:false" in extra:
                    assert 'Button "expand"' in result.stdout and "Widen to the layout's maximum width (900px)" in result.stdout, "Expand button must show"
                elif "expanded:true" in extra:
                    assert 'Button "expand"' in result.stdout and "Restore panel width" in result.stdout, "Restore state must show"
                else:
                    assert 'Button "expand"' not in result.stdout, "No expand button outside a dock"
                if eager and mode == "prs":
                    assert "Keep branch switching" in result.stdout, "Populated PR list was not rendered"
                if eager and mode == "branches":
                    assert "other-checkout" in result.stdout, "Occupied worktree branch was not rendered"
                print(f"{mode} {width}px {'eager rows' if eager else 'virtual list'}: passed")
    print("Native descriptions passed; this does not prove pixel layout or live interaction.")


if __name__ == "__main__":
    main()
