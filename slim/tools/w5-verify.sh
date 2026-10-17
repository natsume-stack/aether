#!/bin/bash
# W5 verification: syntax check + measured-budget self-test, run inside the
# shipped engine image (WSL host has no node). Read-only mounts, throwaway
# containers; nothing touches the running box-local-engine-* stack.
set -u
SRC="/mnt/d/desktop/神奇代码岛/box3-local-engine/apps/local-engine/src"
IMG=box-local-engine-play:v2026.1.4-linux-amd64

echo "########## 1) node --check launcher.js (stdin form) ##########"
docker run --rm -i "$IMG" node --check < "$SRC/launcher.js" && echo "launcher.js: --check OK (stdin)"

echo "########## 2) node --check launcher.js + runtime-memory.mjs (file form) ##########"
docker run --rm -v "$SRC:/w5:ro" "$IMG" sh -c 'node --check /w5/launcher.js && echo "launcher.js: --check OK"; node --check /w5/runtime-memory.mjs && echo "runtime-memory.mjs: --check OK"; node --input-type=module -e "import(\"/w5/runtime-memory.mjs\").then(m=>console.log(\"ESM import exports:\",Object.keys(m).join(\",\")))"'

echo "########## 3) require(esm) from CJS, node version ##########"
docker run --rm -v "$SRC:/w5:ro" "$IMG" sh -c 'node -v; node -e "
const m = require(\"/w5/runtime-memory.mjs\");
const d = m.detectMemoryLimit();
console.log(\"require(esm) OK; detect:\", JSON.stringify({source:d.source,file:d.file,limitMB:d.limitBytes?Math.round(d.limitBytes/1048576):null,currentMB:d.currentBytes?Math.round(d.currentBytes/1048576):null,cpuQuota:d.cpuQuota,note:d.note}));
"'

echo "########## 4) --print self-test: creator-shaped container (6g, pool 10) ##########"
docker run --rm --memory=6g --cpus=4 -v "$SRC:/w5:ro" "$IMG" node /w5/runtime-memory.mjs --print --runtimes 10

echo "########## 5) --print self-test: play-shaped container (4g, pool 8) ##########"
docker run --rm --memory=4g -v "$SRC:/w5:ro" "$IMG" node /w5/runtime-memory.mjs --print --runtimes 8

echo "########## 6) --print self-test: no cgroup limit (inherits WSL root cgroup) ##########"
docker run --rm -v "$SRC:/w5:ro" "$IMG" node /w5/runtime-memory.mjs --print --runtimes 10

echo "########## 7) --print self-test: small private box 2g pool 10 + explicit env ##########"
docker run --rm --memory=2g -v "$SRC:/w5:ro" -e BOX_SCRIPT_HEAP_MB=512 -e SCRIPT_MEMORY_LIMIT=512 "$IMG" node /w5/runtime-memory.mjs --print --runtimes 10
echo "--- same 2g box, operator explicitly asks 1024 ---"
docker run --rm --memory=2g -v "$SRC:/w5:ro" "$IMG" node /w5/runtime-memory.mjs --print --runtimes 10 --explicit 1024

echo "########## 8) parity table: legacy ladder vs measured, explicit env must match ##########"
docker run --rm --memory=6g -v "$SRC:/w5:ro" "$IMG" node -e "
const m = require('/w5/runtime-memory.mjs');
const tier = (v) => (v > 64*1024*1024 ? 2048 : v > 16*1024*1024 ? 1024 : 512);
const legacy = (envStr, voxels) => {
  const cfg = Number(envStr || 512);
  return Math.max(Number.isFinite(cfg) ? cfg : 512, tier(voxels));
};
const cases = [
  ['unset', 1], ['unset', 512*128*512], ['unset', 16*1024*1024+1], ['unset', 64*1024*1024+1],
  ['512', 1], ['512', 16*1024*1024+1], ['512', 64*1024*1024+1],
  ['1024', 1], ['1024', 64*1024*1024+1], ['2048', 1], ['0', 1], ['abc', 1],
];
let mismatch = 0;
for (const pool of [10, 8]) {
  console.log('--- pool=' + pool + ' (compat mode = byte-identical rollback) ---');
  for (const [envStr, voxels] of cases) {
    const explicit = envStr === 'unset' ? null : Number(envStr);
    const got = m.deriveScriptMemoryBudget({
      voxelCount: voxels,
      explicitMB: Number.isFinite(explicit) ? explicit : null,
      concurrentRuntimes: pool,
      mode: 'compat',
    });
    const want = legacy(envStr === 'unset' ? '' : envStr, voxels);
    const ok = got.mb === want;
    if (!ok) mismatch++;
    console.log(\`env=\${envStr.padEnd(5)} voxels=\${String(voxels).padStart(11)} legacy=\${want} measured-compat=\${got.mb} basis=\${got.basis} \${ok ? 'SAME' : 'DIFF'}\`);
  }
}
console.log('compat-mode mismatches vs legacy formula:', mismatch);
"

echo "########## 9) same matrix in DEFAULT (measured) mode, 6g creator ##########"
docker run --rm --memory=6g -v "$SRC:/w5:ro" "$IMG" node -e "
const m = require('/w5/runtime-memory.mjs');
const cases = [ ['unset',1], ['unset',512*128*512], ['unset',16*1024*1024+1], ['unset',64*1024*1024+1], ['512',1], ['512',64*1024*1024+1], ['1024',1] ];
for (const [envStr, voxels] of cases) {
  const b = m.deriveScriptMemoryBudget({ voxelCount: voxels, explicitMB: envStr==='unset'?null:Number(envStr), concurrentRuntimes: 10 });
  console.log('env='+envStr.padEnd(5)+' voxels='+String(voxels).padStart(11)+' -> '+String(b.mb).padStart(4)+'MB basis='+b.basis+(b.headroom?('  '+b.headroom):'')+(b.warning?('  '+b.warning):''));
}
"

echo "########## 10) real launcher.js top level: module present (src dir mounted) ##########"
docker run --rm --memory=6g -v "/mnt/d/desktop/神奇代码岛/box3-local-engine/apps/local-engine:/app2/apps/local-engine:ro" "$IMG" sh -c 'cd /app2 && node apps/local-engine/src/launcher.js --creator --play 2>&1 | head -8'
echo "--- with compose-style explicit env (BOX_SCRIPT_HEAP_MB=512 SCRIPT_MEMORY_LIMIT=512) ---"
docker run --rm --memory=6g -e BOX_SCRIPT_HEAP_MB=512 -e SCRIPT_MEMORY_LIMIT=512 -v "/mnt/d/desktop/神奇代码岛/box3-local-engine/apps/local-engine:/app2/apps/local-engine:ro" "$IMG" sh -c 'cd /app2 && node apps/local-engine/src/launcher.js --creator --play 2>&1 | head -8'
echo "--- compat rollback switch ---"
docker run --rm --memory=6g -e BOX_SCRIPT_MEMORY_BUDGET=compat -v "/mnt/d/desktop/神奇代码岛/box3-local-engine/apps/local-engine:/app2/apps/local-engine:ro" "$IMG" sh -c 'cd /app2 && node apps/local-engine/src/launcher.js --creator --play 2>&1 | head -6'

echo "########## 11) real launcher.js top level WITHOUT runtime-memory.mjs in the image (fallback) ##########"
docker run --rm -v "$SRC/launcher.js:/app/apps/local-engine/src/launcher.js:ro" "$IMG" sh -c 'cd /app && ls apps/local-engine/src/runtime-memory.mjs 2>&1; node apps/local-engine/src/launcher.js --creator --play 2>&1 | head -6'

echo "########## 12) runtime-memory.mjs --check inside the creator image shape ##########"
docker run --rm --memory=6g -v "$SRC:/w5:ro" "$IMG" node /w5/runtime-memory.mjs --print --runtimes 10 --voxels 100663296 --json | tail -2
echo "[done]"
