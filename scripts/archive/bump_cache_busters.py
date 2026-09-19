#!/usr/bin/env python3
"""
bump_cache_busters.py — Bump the ?v=N cache-buster for changed frontend assets.

Scans index.html for <script src="X.js?v=N"> and <link rel="stylesheet" href="Y.css?v=N">,
and bumps N for every asset that changed on disk since the last commit. Safe to
run before every deploy:

    python3 scripts/bump_cache_busters.py [--all]

Use --all to bump every asset regardless of git status.
"""

import re
import subprocess
import sys

HTML = "index.html"

ALL = "--all" in sys.argv


def changed_assets():
    """Return the set of local asset filenames modified/untracked vs HEAD."""
    p = subprocess.run(
        ["git", "status", "--porcelain", "--", "*.js", "*.css"],
        capture_output=True, text=True,
    )
    names = set()
    for line in p.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            names.add(parts[-1].strip())
    return names


def bump():
    with open(HTML, "r", encoding="utf-8") as f:
        html = f.read()

    changed = changed_assets() if not ALL else None
    pattern = re.compile(
        r'(<(?:script|link)[^>]+(?:src|href)=")([A-Za-z0-9_.-]+)(\?v=)(\d+)(")'
    )
    bumped = []

    def repl(m):
        prefix, name, q, ver, quote = m.groups()
        if ALL or (changed is not None and name in changed):
            new_ver = str(int(ver) + 1)
            bumped.append((name, ver, new_ver))
            return f"{prefix}{name}{q}{new_ver}{quote}"
        return m.group(0)

    new_html = pattern.sub(repl, html)
    if not bumped:
        print("No changed assets to bump.")
        return

    with open(HTML, "w", encoding="utf-8") as f:
        f.write(new_html)

    for name, old, new in bumped:
        print(f"  {name}: v{old} -> v{new}")


if __name__ == "__main__":
    bump()
