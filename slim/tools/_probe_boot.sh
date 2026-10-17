#!/usr/bin/env bash
# READ-ONLY boot + config + process probe. No stop/restart/write to ~/box3.
set +e
SRV="creator play voxa player-service player-auth-portal server-manager managed-postgres"

echo "===== INSPECT BOOT / CONFIG / HEALTH (host time: $(date -u +%FT%TZ)) ====="
for s in $SRV; do
  n="box-local-engine-$s-1"
  echo "##### $n"
  docker inspect \
    --format 'created={{.Created}}
started={{.State.StartedAt}}
finished={{.State.FinishedAt}}
restarts={{.RestartCount}}
state={{.State.Status}}
ram_limit_bytes={{.HostConfig.Memory}}
cpus={{.HostConfig.NanoCpus}}
retr_policy={{.HostConfig.RestartPolicy.Name}}
health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}
health_interval={{if .Config.Healthcheck}}{{.Config.Healthcheck.Interval}}{{else}}-{{end}}
health_timeout={{if .Config.Healthcheck}}{{.Config.Healthcheck.Timeout}}{{else}}-{{end}}
health_startperiod={{if .Config.Healthcheck}}{{.Config.Healthcheck.StartPeriod}}{{else}}-{{end}}
cmd={{json .Config.Cmd}}
entrypoint={{json .Config.Entrypoint}}' "$n" 2>&1
  echo "-- health log (last probes: start/end/exit) --"
  docker inspect --format '{{range .State.Health.Log}}[start={{.Start}} end={{.End}} exit={{.ExitCode}}]
{{end}}' "$n" 2>&1 | head -6
  echo
done

echo "===== PROCESSES PER CONTAINER ====="
for s in creator play voxa player-service player-auth-portal server-manager; do
  n="box-local-engine-$s-1"
  echo "##### $n"
  echo "-- ps by rss --"
  docker exec "$n" sh -c 'ps -eo pid,ppid,rss,vsz,pcpu,etime,comm --sort=-rss 2>/dev/null | head -14' 2>&1
  echo "-- node proc count --"
  docker exec "$n" sh -c 'n=0; for d in /proc/[0-9]*; do c=$(tr -d "\0" < $d/cmdline 2>/dev/null); case "$c" in *node*) n=$((n+1));; esac; done; echo node=$n' 2>&1
  echo "-- each node pid: VmRSS/VmHWM/Threads + arg + task count --"
  docker exec "$n" sh -c 'for d in /proc/[0-9]*; do p=${d#/proc/}; c=$(tr -d "\0" < $d/cmdline 2>/dev/null); case "$c" in *node*) echo "PID=$p ARG=$c"; grep -E "^(VmRSS|VmHWM|Threads|VmSwap)" $d/status 2>/dev/null; echo "  tasks=$(ls -1 $d/task 2>/dev/null | wc -l) fd=$(ls -1 $d/fd 2>/dev/null | wc -l)"; ;; esac; done' 2>&1
  echo "-- ss sockets summary --"
  docker exec "$n" sh -c 'ss -s 2>/dev/null | head -5' 2>&1
  echo
done

echo "===== server-manager (Rust) proc ====="
docker exec box-local-engine-server-manager-1 sh -c 'ps -eo pid,ppid,rss,vsz,pcpu,etime,comm,args --sort=-rss 2>/dev/null | head -10' 2>&1

echo "===== env: heap/memory caps per JS container ====="
for s in creator play voxa player-service player-auth-portal; do
  n="box-local-engine-$s-1"
  echo "##### $n"
  docker exec "$n" sh -c 'cat /proc/1/environ 2>/dev/null | tr "\0" "\n" | grep -Ei "NODE_OPTIONS|MEMORY|HEAP|MAX_OLD|BOX_DEPLOYMENT|SCRIPT_|UV_|WORKER" ' 2>&1
done
