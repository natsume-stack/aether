#!/usr/bin/env python3
"""sync-from-feather.py — 把 feather ai-author/visual 的引擎源同步进 aether/ 仓库目录

开发在 feather 目录（智能体/自测就地可跑），发布进本仓库 aether/ 子目录。
命名映射（重命名即品牌）：
  game-design-brain.mjs   -> src/muse/muse.mjs
  gdd-validate.mjs        -> src/muse/gdd-validate.mjs
  ui-theme-kit.mjs        -> src/prism/prism-kit.mjs
  ui-layout-solver.mjs    -> src/prism/prism-layout.mjs
  ui-theme-render.mjs     -> src/prism/prism-render.mjs
  ui-theme-engine-bridge  -> src/prism/prism-bridge.mjs
  terrain-engine.mjs      -> src/gaia/terrain-engine.mjs      （gaia）
  terrain-render.mjs      -> src/gaia/terrain-render.mjs
  terrain-executor.mjs    -> src/gaia/terrain-executor.mjs
  model-sculpt.mjs        -> src/chisel/model-sculpt.mjs      （chisel v3）
  sculpt-library.mjs      -> src/chisel/sculpt-library.mjs
  run-model-v3.mjs        -> src/chisel/run-model-v3.mjs
用法：python scripts/sync-from-feather.py [--commit "msg"]  （--commit 时自动 git add+commit+push，代理 127.0.0.1:7897）
"""
import os, sys, subprocess, io

FEATHER = r"D:/desktop/神奇代码岛/_ext/feather/tools/ai-author/visual"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AETHER = os.path.join(REPO, "aether")  # 仓库内 aether/ 子目录

MAP = {
    "game-design-brain.mjs": "src/muse/muse.mjs",
    "gdd-validate.mjs": "src/muse/gdd-validate.mjs",
    "selftest/brain/run-selftest.mjs": "src/muse/selftest/brain/run-selftest.mjs",
    "ui-theme-kit.mjs": "src/prism/prism-kit.mjs",
    "ui-layout-solver.mjs": "src/prism/prism-layout.mjs",
    "ui-theme-render.mjs": "src/prism/prism-render.mjs",
    "ui-theme-engine-bridge.mjs": "src/prism/prism-bridge.mjs",
    "selftest/ui/run-selftest.mjs": "src/prism/selftest/ui/run-selftest.mjs",
    "selftest/integration/run-pipeline.mjs": "examples/run-pipeline.mjs",
    # gaia / chisel（智能体产出后自动纳入）
    "terrain-engine.mjs": "src/gaia/terrain-engine.mjs",
    "terrain-render.mjs": "src/gaia/terrain-render.mjs",
    "terrain-executor.mjs": "src/gaia/terrain-executor.mjs",
    "selftest/terrain/run-selftest.mjs": "src/gaia/selftest/run-selftest.mjs",
    "model-sculpt.mjs": "src/chisel/model-sculpt.mjs",
    "sculpt-library.mjs": "src/chisel/sculpt-library.mjs",
    "run-model-v3.mjs": "src/chisel/run-model-v3.mjs",
    "selftest/model/run-selftest.mjs": "src/chisel/selftest/run-selftest.mjs",
}
# 同步后需要修正的相对导入
IMPORT_FIXES = {
    "src/prism/prism-layout.mjs": [("./ui-theme-kit.mjs", "./prism-kit.mjs")],
    "src/prism/prism-render.mjs": [("./png.mjs", "../shared/png.mjs"), ("./renderer.mjs", "../shared/renderer.mjs"), ("./ui-theme-kit.mjs", "./prism-kit.mjs")],
    "src/prism/prism-bridge.mjs": [("./common.mjs", "../shared/common.mjs"), ("./ui-layout-solver.mjs", "./prism-layout.mjs"), ("ui-theme-engine-bridge.mjs", "prism-bridge.mjs")],
    "src/prism/selftest/ui/run-selftest.mjs": [("../../ui-layout-solver.mjs", "../../prism-layout.mjs"), ("../../ui-theme-render.mjs", "../../prism-render.mjs")],
    "src/muse/selftest/brain/run-selftest.mjs": [("../../game-design-brain.mjs", "../../muse.mjs")],
    "examples/run-pipeline.mjs": [("../../game-design-brain.mjs", "../src/muse/muse.mjs"), ("../../gdd-validate.mjs", "../src/muse/gdd-validate.mjs"), ("../../ui-layout-solver.mjs", "../src/prism/prism-layout.mjs"), ("../../ui-theme-render.mjs", "../src/prism/prism-render.mjs"), ("../../terrain-engine.mjs", "../src/gaia/terrain-engine.mjs"), ("../../run-model-v3.mjs", "../src/chisel/run-model-v3.mjs")],
}

def main():
    commit_msg = None
    if "--commit" in sys.argv:
        commit_msg = sys.argv[sys.argv.index("--commit") + 1]
    copied, skipped = [], []
    for src_rel, dst_rel in MAP.items():
        src = os.path.join(FEATHER, src_rel)
        if not os.path.exists(src):
            skipped.append(src_rel); continue
        dst = os.path.join(AETHER, dst_rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        s = io.open(src, encoding="utf-8").read()
        for a, b in IMPORT_FIXES.get(dst_rel, []):
            s = s.replace(a, b)
        io.open(dst, "w", encoding="utf-8", newline="\n").write(s)
        copied.append(f"{src_rel} -> aether/{dst_rel}")
    print(f"synced {len(copied)}, pending {len(skipped)}")
    for c in copied: print("  +", c)
    for sk in skipped: print("  …(未就绪)", sk)
    if commit_msg:
        token = os.environ.get("AETHER_GH_TOKEN")
        if not token:
            print("缺少 AETHER_GH_TOKEN 环境变量（GitHub PAT）"); sys.exit(1)
        def git(*a):
            subprocess.run(["git", *a], cwd=REPO, check=True)
        git("add", "aether")
        subprocess.run(["git", "commit", "-m", commit_msg], cwd=REPO, check=True)
        git("-c", "http.proxy=http://127.0.0.1:7897", "push", f"https://x-access-token:{token}@github.com/natsume-stack/aether.git", "push-branch:main")
        print("pushed:", commit_msg)

if __name__ == "__main__":
    main()
