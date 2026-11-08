#!/usr/bin/env python3
"""Install or update only the Git mod. Layouts, settings and keybindings are never written here.

Refuses to touch a mods/Git folder that this checkout did not install (including a
`mods/git` folder on a case-insensitive file system). On update, files removed from
this checkout are removed from the installed copy too.
"""
import os
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
home = Path(os.environ.get("HERDR_APP_HOME", "~/.config/herdr-app")).expanduser()
source, target = root / "mods/Git", home / "mods/Git"
marker = target / ".source"
if target.exists() and (not marker.is_file() or marker.read_text().strip() != str(source)):
    raise SystemExit(f"Refusing to overwrite a mod this checkout did not install: {target}\n"
                     "Rename this mod first (see RECIPE.md, Watch out), or remove that folder yourself.")


def runtime(path):
    return path.is_file() and not path.name.endswith(".d.ts") and path.name != "jsconfig.json" and path.name != ".DS_Store"


wanted = {path.relative_to(source) for path in source.rglob("*") if runtime(path)}
target.mkdir(parents=True, exist_ok=True)
for relative in sorted(wanted):
    dest = target / relative
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / relative, dest)
# Herdr writes jsconfig.json and .d.ts files into the mod folder; keep those.
for path in sorted(target.rglob("*"), reverse=True):
    relative = path.relative_to(target)
    if path.is_file() and runtime(path) and relative not in wanted and relative != Path(".source"):
        path.unlink()
    elif path.is_dir() and not any(path.iterdir()):
        path.rmdir()
marker.write_text(str(source) + "\n")
print(target)
