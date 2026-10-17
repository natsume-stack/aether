#!/usr/bin/env python3
"""W1 residual-risk audit.

For every package name the prune script intends to remove, find REAL require /
import sites inside the packages that SURVIVE in the tree. A hit means the pruned
package could still be loaded at request time, which the boot gate would not
catch. Run against the unpruned copy so the survivors are all present.

usage: w1-req-audit.py <tree-root> <name> [<name> ...]
"""
import os
import re
import sys
import json

EXTS = (".js", ".cjs", ".mjs", ".jsx")
root = sys.argv[1]
names = sys.argv[2:]

patterns = {}
for n in names:
    esc = re.escape(n)
    patterns[n] = re.compile(
        r"""(?:require|import|resolve)\s*\(\s*['"]""" + esc + r"""(?:/|['"])"""
        r"""|\bfrom\s+['"]""" + esc + r"""(?:/|['"])""",
        re.M,
    )

hits = {n: [] for n in names}
scanned = 0
for dirpath, dirnames, filenames in os.walk(root):
    if os.path.basename(dirpath) == "dist":
        continue
    for fn in filenames:
        if not fn.endswith(EXTS):
            continue
        full = os.path.join(dirpath, fn)
        try:
            if os.path.getsize(full) > 12 * 1024 * 1024:
                continue
            with open(full, encoding="utf-8", errors="ignore") as fh:
                text = fh.read()
        except Exception:
            continue
        scanned += 1
        for n in names:
            if patterns[n].search(text):
                # attribute to the owning package directory
                parts = dirpath.split(os.sep)
                owner = None
                for i, p in enumerate(parts):
                    if p == "node_modules" and i + 1 < len(parts):
                        owner = "/".join(parts[i + 1 : i + 3]) if parts[i + 1].startswith("@") else parts[i + 1]
                rel_owner = owner or ""
                # skip the package requiring itself
                norm_n = n.replace("/", "+") if rel_owner.startswith("@") else n
                if rel_owner.replace("+", "/") == n or rel_owner == n or rel_owner == norm_n.replace("+", "/"):
                    continue
                if n.startswith("@") and rel_owner.split("/")[0] == n.split("/")[0]:
                    if rel_owner == n:
                        continue
                hits[n].append((rel_owner, os.path.relpath(full, root)))

print(f"scanned {scanned} js-family files under {root}\n")
for n in names:
    uniq = sorted(set(hits[n]))
    print(f"### {n}: {len(uniq)} external require site(s)")
    for owner, f in uniq[:10]:
        print(f"    owner={owner or '?':32s} {f}")
print("\nJSON " + json.dumps({n: len(set(hits[n])) for n in names}))
