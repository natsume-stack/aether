#!/usr/bin/env python3
"""W1 design probe: for candidate build-tool package names, find which SURVIVING
packages declare them as hard runtime deps (dependencies / optionalDependencies)
vs only dev/peer. Validates the prune script's dep-edge safety rule."""
import json
import os
import sys
from collections import defaultdict

CANDIDATES = {
    "typescript",
    "@swc/core",
    "@swc/core-linux-x64-gnu",
    "esbuild",
    "@esbuild/linux-x64",
    "sass",
    "@babel/types",
    "@babel/helper-string-parser",
    "@babel/helper-validator-identifier",
    "babel-plugin-react-compiler",
    "terser",
    "webpack",
    "sql.js",
}

root = sys.argv[1]
edges = defaultdict(list)  # candidate name -> [(declaring pkg, field)]
present = set()

for dep_dir in sorted(os.listdir(root)):
    nm = os.path.join(root, dep_dir, "node_modules")
    if not os.path.isdir(nm):
        continue
    for real in sorted(os.listdir(nm)):
        pj = os.path.join(nm, real, "package.json")
        if real.startswith("@"):
            for sub in sorted(os.listdir(os.path.join(nm, real))):
                pj = os.path.join(nm, real, sub, "package.json")
                if not os.path.isfile(pj):
                    continue
                try:
                    data = json.load(open(pj))
                except Exception:
                    continue
                scope, _, name = real.partition("/")
                full = f"{scope}/{name}" if scope and name else real
                present.add(full)
                for field in ("dependencies", "optionalDependencies", "peerDependencies", "devDependencies"):
                    for k in (data.get(field) or {}):
                        if k in CANDIDATES and k != full:
                            edges[k].append((full, field))
            continue
        if not os.path.isfile(pj):
            continue
        try:
            data = json.load(open(pj))
        except Exception:
            continue
        present.add(real)
        for field in ("dependencies", "optionalDependencies", "peerDependencies", "devDependencies"):
            for k in (data.get(field) or {}):
                if k in CANDIDATES and k != real:
                    edges[k].append((real, field))

print(f"scanned {root}: {len(present)} package.json files")
for cand in sorted(CANDIDATES):
    hard = [(p, f) for p, f in edges.get(cand, []) if f in ("dependencies", "optionalDependencies")]
    peer = [(p, f) for p, f in edges.get(cand, []) if f == "peerDependencies"]
    dev = [(p, f) for p, f in edges.get(cand, []) if f == "devDependencies"]
    print(f"\n### {cand}: HARD={len(hard)} peer={len(peer)} dev={len(dev)}")
    for p, f in sorted(set(hard)):
        print(f"   HARD  {f:22s} {p}")
    for p, f in sorted(set(peer))[:6]:
        print(f"   peer  {f:22s} {p}")
