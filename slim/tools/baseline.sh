#!/usr/bin/env bash
# =============================================================================
# BOX3 Local Engine - RUNTIME COST BASELINE (READ-ONLY)
# By construction this script only READS: docker ps/inspect/stats/logs/exec-GET,
# /proc, free, curl GET. It NEVER stops/starts/removes/updates/scales a container
# and writes nothing under ~/box3. Safe to run repeatedly to compare before/after.
# Run INSIDE the WSL distro:  bash tools/baseline.sh
# =============================================================================
set -u
SAMPLES="${SAMPLES:-12}"          # idle sampling count
INTERVAL="${INTERVAL:-10}"        # idle sampling interval seconds
CURL_N="${CURL_N:-10}"            # curl timing samples per endpoint
PROJ="box-local-engine"

SVC="creator play voxa player-service player-auth-portal server-manager managed-postgres"
# service -> host port that maps to its HTTP listener (published 127.0.0.1)
hc() { case "$1" in
  creator)          echo "3127";; play)  echo "3121";; voxa) echo "3123";;
  player-service)   echo "3124";; player-auth-portal) echo "3125";; server-manager) echo "3130";;
esac; }

echo "############################################################################"
echo "# BOX3 RUNTIME BASELINE  host=$(uname -sr)  date=$(date -u +%FT%TZ)  TZ=local"
echo "# WSL VM uptime(s): $(awk '{print int($1)}' /proc/uptime)"
echo "############################################################################"

echo
echo "=== [1] CONTAINER INVENTORY (uptime / restarts / mem-limit / ports) ==="
for s in $SVC; do n="${PROJ}-${s}-1";
  docker inspect -f "{{.Name}} status={{.State.Status}} started={{.State.StartedAt}} restarts={{.RestartCount}} memLimit={{.HostConfig.Memory}} cpusNano={{.HostConfig.NanoCpus}}" "$n" 2>&1
done

echo
echo "=== [2] APP PROCESS RSS PER CONTAINER (sum of non-init procs VmRSS, kB, from /proc) ==="
echo "  NOTE: VmRSS double-counts shared mappings (libnode.so is mapped by BOTH the"
echo "        launcher 'node' AND its 'next-server' child), so procRSSsum > real mem."
echo "        The de-duplicated per-container footprint is cgroupMemCurrent / docker stats."
grand=0
for s in $SVC; do n="${PROJ}-${s}-1";
  tot=$(docker exec "$n" sh -c '
    self=$$; t=0
    for d in /proc/[0-9]*; do
      p=${d#/proc/}; [ "$p" = "$self" ] && continue
      [ -r "$d/status" ] || continue
      cmd=$(tr "\0" " " < "$d/cmdline" 2>/dev/null); [ -z "$cmd" ] && continue
      case "$cmd" in *"for d in /proc"*|*"tr \0"*) continue;; esac
      case "$cmd" in tini*|*/sbin/docker-init*) continue;; esac
      r=$(grep -m1 "^VmRSS" "$d/status" 2>/dev/null | tr -s " " | cut -d" " -f2)
      t=$((t + ${r:-0}))
    done; echo $t' 2>/dev/null)
  cg=$(docker exec "$n" sh -c 'cat /sys/fs/cgroup/memory.current 2>/dev/null' 2>/dev/null)
  printf "%-28s procRSSsum_kB=%-9s cgroupMemCurrent_MiB=%-9s\n" "$n" "${tot:-NA}" "$([ -n "${cg:-}" ] && echo $((cg/1024/1024)) || echo NA)"
  [ -n "${tot:-}" ] && grand=$((grand + tot))
done
echo "TOTAL proc VmRSS sum = $grand kB = $((grand/1024)) MiB (shared-mapped, over-counts)"

echo
echo "=== [3] IDLE SAMPLING LOOP: docker stats --no-stream x${SAMPLES} every ${INTERVAL}s ==="
TMP=$(mktemp); : > "$TMP"
snap() { docker ps -q 2>/dev/null | sort | xargs -r docker inspect -f '{{.Name}} {{.State.StartedAt}} {{.RestartCount}}' 2>/dev/null | sort; }
BEFORE=$(snap)
i=0
while [ $i -lt "$SAMPLES" ]; do
  i=$((i+1))
  docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}' 2>/dev/null \
    | awk -v s="$i" -F'\t' '{
        split($2,m," "); memstr=m[1];
        v=memstr; sub(/[^0-9.]/,"",v); u=memstr; sub(/[0-9.]+/,"",u);
        mult=(u=="GiB")?1024:(u=="KiB")?0.0009765625:1;
        cpu=$3; sub(/%/,"",cpu);
        print $1"\t"s"\t"v*mult"\t"cpu }' >> "$TMP"
  [ $i -lt "$SAMPLES" ] && sleep "$INTERVAL"
done
AFTER=$(snap)
echo "restart-during-sample: $( [ "$BEFORE" = "$AFTER" ] && echo NONE || echo "YES(!!) - numbers may be invalid" )"
echo "-- per-container mean/stdev over ${SAMPLES} samples --"
printf "%-26s %12s %12s %12s %10s %10s\n" NAME memMiB_MEAN memMiB_STDEV memMiB_MIN memMiB_MAX CPU_MEAN
awk -F'\t' '{mem[$1" "$2]=$3; names[$1]=1; cpu[$1" "$2]=$4; cnt[$1]++; sum[$1]+=$3; csum[$1]+=$4;
             if(!( $1 in min)|| $3<min[$1])min[$1]=$3; if(!( $1 in max)|| $3>max[$1])max[$1]=$3}
   END{for(nm in names){c=cnt[nm]; m=sum[nm]/c;
        s2=0; for(k=1;k<= '"$SAMPLES"';k++){d=mem[nm" "k]-m; s2+=d*d} sd=(c>1)?sqrt(s2/(c-1)):0;
        printf "%-26s %12.2f %12.2f %12.2f %10.2f %10.3f\n", nm, m, sd, min[nm], max[nm], csum[nm]/c}}' "$TMP" | sort
echo "-- TOTAL idle MEM (sum of means) MiB --"
awk -F'\t' '{mem[$1" "$2]=$3; cnt[$1]++; sum[$1]+=$3} END{t=0; for(nm in cnt) t+=sum[nm]/cnt[nm]; printf "TOTAL_IDLE_MemUsage_MiB=%.2f\n", t}' "$TMP"
rm -f "$TMP"

echo
echo "=== [4] REQUEST LATENCY: GET health endpoints, ${CURL_N} samples, median ==="
printf "%-22s %8s %8s %8s %8s %8s %6s\n" ENDPOINT ttfb_med ttfb_min total_med total_min HTTP
for s in creator play voxa player-service player-auth-portal server-manager; do
  p=$(hc "$s"); [ -z "$p" ] && continue
  url="http://127.0.0.1:${p}/api/health-check"
  [ "$s" = "server-manager" ] && url="http://127.0.0.1:${p}/"
  : > /tmp/curltimes.$$
  k=0
  while [ $k -lt "$CURL_N" ]; do k=$((k+1))
    curl -s -o /dev/null --max-time 10 \
      -w "%{time_starttransfer} %{time_total} %{http_code}\n" "$url" >> /tmp/curltimes.$$ 2>/dev/null
  done
  awk -v ep="$s:$p" 'BEGIN{FS=" "} {tt[NR]=$1; tot[NR]=$2; code=$3; n=NR}
    END{
      for(i=1;i<=n;i++)for(j=i+1;j<=n;j++)if(tt[j]<tt[i]){t=tt[i];tt[i]=tt[j];tt[j]=t}
      for(i=1;i<=n;i++)for(j=i+1;j<=n;j++)if(tot[j]<tot[i]){t=tot[i];tot[i]=tot[j];tot[j]=t}
      m=(n%2)?tt[int(n/2)+1]:(tt[int(n/2)]+tt[int(n/2)+1])/2
      mt=(n%2)?tot[int(n/2)+1]:(tot[int(n/2)]+tot[int(n/2)+1])/2
      printf "%-22s %8.4f %8.4f %8.4f %8.4f %6s\n", ep, m, tt[1], mt, tot[1], code}' /tmp/curltimes.$$
  rm -f /tmp/curltimes.$$
done

echo
echo "=== [5] WSL / VM MEMORY ==="
echo "-- free -m inside WSL --"; free -m
echo "-- /proc/meminfo headline --"; grep -E "^MemTotal|^MemAvailable|^MemFree" /proc/meminfo
echo "-- cgroup usage of all box containers (memory.current bytes) --"
tot=0; for s in $SVC; do n="${PROJ}-${s}-1"; c=$(docker exec "$n" sh -c 'cat /sys/fs/cgroup/memory.current 2>/dev/null' 2>/dev/null); [ -n "$c" ] && tot=$((tot+c)); done
echo "sum memory.current = $tot bytes = $((tot/1024/1024)) MiB"

echo
echo "=== [6] END OF BASELINE  $(date -u +%FT%TZ) ==="
