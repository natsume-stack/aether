#!/usr/bin/env bash
# READ-ONLY: full /proc descendant walk per container. No procps assumed.
set +e

echo "=== date / uptime / ps (stability check) ==="
date -u +%FT%TZ; cat /proc/uptime; echo "-- docker ps --"; docker ps --format "{{.Names}}\t{{.Status}}\t{{.RunningFor}}"

walk() {
  local n="$1"
  echo "##### $n"
  docker exec "$n" sh -c '
    self=$$
    for d in /proc/[0-9]*; do
      p=${d#/proc/}
      [ "$p" = "$self" ] && continue
      cmd=$(tr "\0" " " < "$d/cmdline" 2>/dev/null)
      [ -z "$cmd" ] && continue
      case "$cmd" in *"for d in /proc"*|*"tr \0"*) continue;; esac
      st="$d/status"
      rss=$(grep -m1 "^VmRSS" "$st" 2>/dev/null | tr -s " " | cut -d" " -f2)
      hwm=$(grep -m1 "^VmHWM" "$st" 2>/dev/null | tr -s " " | cut -d" " -f2)
      vmsz=$(grep -m1 "^VmSize" "$st" 2>/dev/null | tr -s " " | cut -d" " -f2)
      thr=$(grep -m1 "^Threads" "$st" 2>/dev/null | tr -s " " | cut -d" " -f2)
      ppid=$(grep -m1 "^PPid" "$st" 2>/dev/null | tr -s " " | cut -d" " -f2)
      fds=$(ls "$d/fd" 2>/dev/null | wc -l)
      comm=$(cat "$d/comm" 2>/dev/null)
      et=$(ls -d --time-style=+%s -1 "$d" 2>/dev/null)
      echo "pid=$p ppid=$ppid comm=$comm RSSkB=$rss HWMkB=$hwm VmSizekB=$vmsz Threads=$thr FD=$fds CMD=[$cmd]"
    done
  ' 2>&1
  echo "-- listening sockets (ss -tlnp) --"
  docker exec "$n" sh -c 'ss -tlnp 2>/dev/null' 2>&1 | head -20
  echo "-- established conns (ss -tnp) --"
  docker exec "$n" sh -c 'ss -tnp 2>/dev/null' 2>&1 | head -25
  echo "-- smaps_rollup of main app pids --"
  docker exec "$n" sh -c '
    self=$$
    for d in /proc/[0-9]*; do
      p=${d#/proc/}; [ "$p" = "$self" ] && continue
      cmd=$(tr "\0" " " < "$d/cmdline" 2>/dev/null)
      case "$cmd" in node*|*next-server*|*server-manager*|postgres*) echo "== pid=$p [$cmd]"; cat "$d/smaps_rollup" 2>/dev/null | grep -E "^(Rss|Pss|Pss_Anon|Anonymous|Swap|VmFlags)";; esac
    done
  ' 2>&1
  echo
}

for s in creator play voxa player-service player-auth-portal server-manager managed-postgres; do
  walk "box-local-engine-$s-1"
done

echo "===== node vs next-server vs rust process COUNT per container ====="
for s in creator play voxa player-service player-auth-portal server-manager managed-postgres; do
  n="box-local-engine-$s-1"
  echo -n "$n : "
  docker exec "$n" sh -c '
    self=$$; node=0; next=0; other=0
    for d in /proc/[0-9]*; do
      p=${d#/proc/}; [ "$p" = "$self" ] && continue
      c=$(cat "$d/comm" 2>/dev/null)
      cmd=$(tr "\0" " " < "$d/cmdline" 2>/dev/null)
      [ -z "$cmd" ] && continue
      case "$cmd" in *"for d in /proc"*|*"tr \0"*) continue;; esac
      case "$c" in node) node=$((node+1));; next-serv*) next=$((next+1));; tini|docker-init|sh|postgres*|server-man*) ;; *) other=$((other+1)); echo -n "[other:$c] ";; esac
    done
    echo "node=$node nextserver=$next"
  ' 2>&1
done
