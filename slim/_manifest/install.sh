#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$root"

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker Engine and Docker Compose v2 are required.' >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo 'Docker Engine is not running or the current user cannot access it. Start Docker and re-login after joining the docker group.' >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo 'Docker Compose v2 plugin is required. The old docker-compose command is not supported.' >&2
  exit 1
fi

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

# New versions can add required internal tokens. Keep valid operator-provided
# values, but provision an absent, placeholder or too-short value for both
# first installs and upgrades from an older .env.
ensure_secret() {
  key=$1
  placeholder=$2
  current=$(sed -n "s/^${key}=//p" .env | tail -n 1)
  if [ "$current" != "$placeholder" ] && [ "${#current}" -ge 32 ]; then
    return
  fi
  secret=$(random_hex)
  if grep -q "^${key}=" .env; then
    sed -i.bak "s|^${key}=.*|${key}=${secret}|" .env
    rm -f .env.bak
  else
    printf '%s=%s\n' "$key" "$secret" >>.env
  fi
  echo "Generated a required secret for ${key}."
}

if [ ! -f .env ]; then
  cp .env.example .env
  permission_secret=$(random_hex)
  auth_secret=$(random_hex)
  admin_secret=$(random_hex)
  manager_secret=$(random_hex)
  runtime_manager_secret=$(random_hex)
  # The Web manager runs inside a container, so it cannot discover the host LAN
  # address itself. Record it now, while we are still on the host.
  lan_ip=''
  if command -v ip >/dev/null 2>&1; then
    lan_ip=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -n 1)
  fi
  if [ -z "$lan_ip" ] && command -v hostname >/dev/null 2>&1; then
    lan_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  fi
  sed -i.bak \
    -e "s/CHANGE_ME_PERMISSION_TOKEN_SECRET/$permission_secret/" \
    -e "s/CHANGE_ME_PLAYER_AUTH_API_KEY/$auth_secret/" \
    -e "s/CHANGE_ME_PLAY_ADMIN_TOKEN/$admin_secret/" \
    -e "s/CHANGE_ME_SERVER_MANAGER_TOKEN/$manager_secret/" \
    -e "s/CHANGE_ME_RUNTIME_MANAGER_TOKEN/$runtime_manager_secret/" \
    -e "s/^BOX_LAN_IP=.*/BOX_LAN_IP=$lan_ip/" .env
  rm -f .env.bak
  chmod 600 .env
  echo 'Created .env. Review it before exposing any service to a LAN or the internet.'
fi

ensure_secret BOX_SERVER_MANAGER_TOKEN CHANGE_ME_SERVER_MANAGER_TOKEN
ensure_secret BOX_RUNTIME_MANAGER_TOKEN CHANGE_ME_RUNTIME_MANAGER_TOKEN

archive='box-local-engine-image-server-manager-amd64-4cb908cee3d9f097e4f7e6f310158e313ab4fc1fc462d3cb170e770b73322179.tar.gz'
if [ ! -f BOX3-IMAGE-CATALOG.json ]; then
  echo 'Missing BOX3-IMAGE-CATALOG.json' >&2
  exit 1
fi

./verify.sh
mkdir -p cache/engine-images
archive_path="cache/engine-images/$archive"
expected_sha=$(sed -n 's/^[[:space:]]*"sha256": "\([a-fA-F0-9]*\)".*/\1/p' BOX3-MANAGER-IMAGE.json)
[ "${#expected_sha}" -eq 64 ] || { echo 'Invalid Server Manager image checksum.' >&2; exit 1; }
expected_size=$(sed -n 's/^[[:space:]]*"size": \([0-9][0-9]*\).*/\1/p' BOX3-MANAGER-IMAGE.json)
[ -n "$expected_size" ] || { echo 'Invalid Server Manager image size.' >&2; exit 1; }
actual_sha=''
if [ -f "$archive_path" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    actual_sha=$(sha256sum "$archive_path" | awk '{print $1}')
  else
    actual_sha=$(shasum -a 256 "$archive_path" | awk '{print $1}')
  fi
fi
if [ "$actual_sha" != "$expected_sha" ]; then
  if [ -f BOX3-PACKAGE-MODE.json ] && grep -Eq '"mode"[[:space:]]*:[[:space:]]*"local"' BOX3-PACKAGE-MODE.json; then
    echo '本地镜像归档缺失或损坏，请重新生成本地测试包。' >&2
    exit 1
  fi
  partial="$archive_path.part"
  if [ -f "$partial" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      actual_sha=$(sha256sum "$partial" | awk '{print $1}')
    else
      actual_sha=$(shasum -a 256 "$partial" | awk '{print $1}')
    fi
    if [ "$actual_sha" = "$expected_sha" ]; then
      mv "$partial" "$archive_path"
    elif [ "$(wc -c < "$partial")" -ge "$expected_size" ]; then
      rm -f "$partial"
      actual_sha=''
    else
      actual_sha=''
    fi
  fi
  if [ "$actual_sha" != "$expected_sha" ]; then
    curl -fL --retry 2 --progress-bar -C - \
      "https://assets.box3.fun/local-engine/$archive" -o "$partial"
    if command -v sha256sum >/dev/null 2>&1; then
      actual_sha=$(sha256sum "$partial" | awk '{print $1}')
    else
      actual_sha=$(shasum -a 256 "$partial" | awk '{print $1}')
    fi
    if [ "$actual_sha" != "$expected_sha" ] || [ "$(wc -c < "$partial")" -ne "$expected_size" ]; then
      rm -f "$partial"
      echo 'Server Manager image SHA-256 verification failed.' >&2
      exit 1
    fi
    mv "$partial" "$archive_path"
  fi
fi
echo 'Loading the Linux Web manager image…'
docker load -i "$archive_path"
image_tag=$(sed -n 's/^BOX_IMAGE_TAG=//p' .env | tail -n 1)
case "$image_tag" in
  ''|*[!A-Za-z0-9._-]*) echo 'Invalid BOX_IMAGE_TAG in .env' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64) expected_arch=amd64 ;;
  aarch64|arm64) expected_arch=arm64 ;;
  *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac
manager_content_tag=$(sed -n 's/^[[:space:]]*"contentTag": "\([^"]*\)".*/\1/p' BOX3-MANAGER-IMAGE.json)
[ -n "$manager_content_tag" ] || { echo 'Invalid Server Manager image manifest.' >&2; exit 1; }
docker tag "$manager_content_tag" "box-local-engine-server-manager:$image_tag"
image="box-local-engine-server-manager:$image_tag"
actual_arch=$(docker image inspect "$image" --format '{{.Architecture}}')
if [ "$actual_arch" != "$expected_arch" ]; then
  echo "Image architecture mismatch for $image: expected $expected_arch, got $actual_arch" >&2
  exit 1
fi
content_id=$(docker image inspect "$manager_content_tag" --format '{{.Id}}')
release_id=$(docker image inspect "$image" --format '{{.Id}}')
[ "$content_id" = "$release_id" ] || { echo 'Server Manager release tag verification failed.' >&2; exit 1; }
docker image rm "$manager_content_tag" >/dev/null 2>&1 || true
echo 'Starting the Linux Web manager…'
docker compose --env-file .env -f compose.yml up -d --no-build --remove-orphans --wait server-manager
echo 'Done. Linux Web manager: http://127.0.0.1:3130'
echo 'Use BOX_SERVER_MANAGER_TOKEN from .env to sign in. Keep this token private.'
echo 'Configure the database in the Web manager, then start the required engine services.'
