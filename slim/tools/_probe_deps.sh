#!/usr/bin/env bash
# READ-ONLY: startup log timeline + inter-service dependency graph.
set +u
PROJ=box-local-engine
echo "===== [4b] STARTUP LOG TIMELINE (first + first 'listening/ready' line) ====="
for s in creator play voxa player-service player-auth-portal server-manager; do
  n="${PROJ}-${s}-1"
  echo "##### $n  (StartedAt=$(docker inspect -f '{{.State.StartedAt}}' "$n"))"
  echo "-- earliest 4 log lines --"
  docker logs --timestamps "$n" 2>&1 | head -4
  echo "-- first line mentioning listen/ready/port/startup/Server --"
  docker logs --timestamps "$n" 2>&1 | grep -m1 -Ei "listen|ready|running on|started server|:300|:3001|:321|port|Local:|Startup" 
  echo "-- last (most recent) log line time --"
  docker logs --timestamps "$n" 2>&1 | tail -1
  echo
done

echo "===== [7b] INTER-SERVICE DEPENDENCY: env URLs/hosts each JS container is configured to call ====="
for s in creator play voxa player-service player-auth-portal server-manager; do
  n="${PROJ}-${s}-1"
  echo "##### $n"
  docker exec "$n" sh -c 'tr "\0" "\n" < /proc/1/environ 2>/dev/null | grep -Ei "URL|HOST|ADDR|ENDPOINT|_API|POSTGRES|REDIS|DATABASE|:31|:32|:300|server-manager|player|voxa|auth|creator|play"' 2>&1 | head -30
  echo
done

echo "===== [7c] LIVE ESTABLISHED CONNECTIONS across all containers (who calls whom NOW) ====="
for s in creator play voxa player-service player-auth-portal server-manager; do
  n="${PROJ}-${s}-1"
  echo -n "$n : "; docker exec "$n" sh -c 'ss -tn state established 2>/dev/null | tail -n +2 | awk "{print \$4}"' 2>/dev/null | paste -sd' ' -
done
echo "===== [7d] image list (external deps required) ====="
docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | grep -Ei "box|postgres|redis"
