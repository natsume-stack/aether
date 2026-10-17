#!/bin/bash
# W5 read-only probe: per-process RSS inside the live box-local-engine containers
# + cgroup v2 files visible to the launcher process.
set -u
IMG=box-local-engine-play:v2026.1.4-linux-amd64
cat > /tmp/w5proc.js <<'EOF'
const fs = require('fs');
const ids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
const rows = [];
for (const id of ids) {
  try {
    const cmd = fs.readFileSync('/proc/' + id + '/cmdline', 'utf8').split('\0').filter(Boolean).join(' ');
    const st = fs.readFileSync('/proc/' + id + '/status', 'utf8');
    const rss = Number((/^VmRSS:\s+(\d+)\s+kB$/m.exec(st) || [])[1] || 0);
    const ppid = Number((/^PPid:\s+(\d+)$/m.exec(st) || [])[1] || 0);
    const threads = Number((/^Threads:\s+(\d+)$/m.exec(st) || [])[1] || 0);
    if (!cmd) continue;
    rows.push({ pid: Number(id), ppid, rss, threads, cmd: cmd.slice(0, 92) });
  } catch (e) {}
}
rows.sort((a, b) => b.rss - a.rss);
for (const r of rows) {
  console.log(String(r.rss).padStart(8) + ' kB  pid=' + String(r.pid).padStart(4) + ' ppid=' + String(r.ppid).padStart(4) + ' thr=' + String(r.threads).padStart(3) + '  ' + r.cmd);
}
console.log('PROCS=' + rows.length + ' TOTAL_RSS_MiB=' + (rows.reduce((a, b) => a + b.rss, 0) / 1024).toFixed(2));
EOF
for c in box-local-engine-creator-1 box-local-engine-play-1; do
  echo "===================== $c ====================="
  docker exec -i "$c" sh -c 'cat > /tmp/w5proc.js' < /dev/null 2>/dev/null || true
  docker exec -i "$c" node -e "$(cat /tmp/w5proc.js)" 2>&1 | tail -20
  echo "--- cgroup visible to $c ---"
  docker exec "$c" node -e "const fs=require('fs');for(const p of ['/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory.current','/sys/fs/cgroup/memory.high','/sys/fs/cgroup/cpu.max','/sys/fs/cgroup/memory/memory.limit_in_bytes']){try{console.log(p,'=',fs.readFileSync(p,'utf8').trim())}catch(e){console.log(p,'= ERR',e.code)}}console.log('os.totalmem MB =',(require('os').totalmem()/1048576).toFixed(0));console.log('os.cpus =',require('os').cpus().length)"
done
echo "===================== host WSL cgroup ====================="
node -v 2>&1 || echo "no node on WSL host"
for p in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory/memory.limit_in_bytes; do
  printf '%s = ' "$p"; cat "$p" 2>&1 || true
done
echo "--- /proc/meminfo head ---"
head -5 /proc/meminfo
echo "--- docker run --rm (unlimited, host cgroup inherited) ---"
docker run --rm -i "$IMG" node -e "const fs=require('fs');for(const p of ['/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory.current']){try{console.log(p,'=',fs.readFileSync(p,'utf8').trim())}catch(e){console.log(p,'ERR',e.code)}}console.log('totalmem MB',(require('os').totalmem()/1048576).toFixed(0))"
echo "--- docker run --rm --memory=6g ---"
docker run --rm --memory=6g "$IMG" node -e "console.log(require('fs').readFileSync('/sys/fs/cgroup/memory.max','utf8').trim())"
echo "[exit=$?]"
