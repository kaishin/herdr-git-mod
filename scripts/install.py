#!/usr/bin/env python3
"""Install only the Git mod. Layouts and keybindings are never written here."""
import os
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
home = Path(os.environ.get("HERDR_APP_HOME", "~/.config/herdr-app")).expanduser()
source, target = root / "mods/Git", home / "mods/Git"
marker = target / ".source"
if target.exists() and (not marker.is_file() or marker.read_text().strip() != str(source)):
    raise SystemExit(f"Refusing to overwrite an unrelated mod: {target}")
target.mkdir(parents=True, exist_ok=True)
for path in source.rglob("*"):
    if not path.is_file() or path.name.endswith(".d.ts") or path.name == "jsconfig.json":
        continue
    dest = target / path.relative_to(source)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)
marker.write_text(str(source) + "\n")
print(target)
