#!/bin/bash
exec > /mnt/c/Users/Natsume/AppData/Local/Temp/box3wsl/w6cat.out 2>&1
echo "=== HEAD ==="
head -40 /root/box3docs/srv/BOX3-Engine-Server-2026.1.4-linux-amd64/BOX3-IMAGE-CATALOG.json
echo "=== downloadBaseUrl occurrences ==="
grep -c downloadBaseUrl /root/box3docs/srv/BOX3-Engine-Server-2026.1.4-linux-amd64/BOX3-IMAGE-CATALOG.json
grep -o '"downloadBaseUrl": "[^"]*"' /root/box3docs/srv/BOX3-Engine-Server-2026.1.4-linux-amd64/BOX3-IMAGE-CATALOG.json | sort -u
echo "=== MANAGER-IMAGE ==="
cat /root/box3docs/srv/BOX3-Engine-Server-2026.1.4-linux-amd64/BOX3-MANAGER-IMAGE.json
echo "=== PACKAGE-MODE ==="
cat /root/box3docs/srv/BOX3-Engine-Server-2026.1.4-linux-amd64/BOX3-PACKAGE-MODE.json 2>&1
echo "=== pkg dir listing ==="
ls -la /root/box3docs/srv/BOX3-Engine-Server-2026.1.4-linux-amd64/ | head -25
