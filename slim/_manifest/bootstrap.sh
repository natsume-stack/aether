#!/usr/bin/env sh
# Isolate exits and shell options even when the installer is pasted or sourced.
(
set -eu

# Public bootstrap installer for headless Linux hosts. This file is published
# as the stable `install.sh` release asset; the full offline package keeps its
# own installer for image verification and service startup.

RELEASE_CDN_URL=${BOX3_RELEASE_CDN_URL:-https://assets.box3.fun/local-engine}
INSTALL_DIRECTORY=${BOX3_INSTALL_DIRECTORY:-/opt/box3-engine}
REQUESTED_VERSION=${BOX3_VERSION:-latest}
OS_RELEASE_FILE=${BOX3_OS_RELEASE_FILE:-/etc/os-release}
MANAGER_BIND_IP=${BOX3_MANAGER_BIND_IP:-0.0.0.0}
INSTALL_STARTED_AT=$(date +%s)

if [ -t 1 ]; then
  COLOR_TITLE=$(printf '\033[1;36m')
  COLOR_LABEL=$(printf '\033[1;33m')
  COLOR_SUCCESS=$(printf '\033[1;32m')
  COLOR_RESET=$(printf '\033[0m')
else
  COLOR_TITLE=''
  COLOR_LABEL=''
  COLOR_SUCCESS=''
  COLOR_RESET=''
fi

info() {
  printf '\n[BOX3] %s\n' "$1"
}

fail() {
  printf '\n[BOX3] 安装失败：%s\n' "$1" >&2
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  fail '请使用 curl -fsSL <安装地址>/install.sh | sudo bash 运行安装器。'
fi

if [ "$(uname -s)" != 'Linux' ]; then
  fail '一键安装器只支持 Linux。Windows 和 macOS 请使用桌面发行包。'
fi

case "$(uname -m)" in
  x86_64|amd64) architecture=amd64 ;;
  aarch64|arm64) architecture=arm64 ;;
  *) fail "不支持的 CPU 架构：$(uname -m)" ;;
esac

case "$MANAGER_BIND_IP" in
  127.0.0.1|0.0.0.0) ;;
  *) fail 'BOX3_MANAGER_BIND_IP 只允许设置为 127.0.0.1 或 0.0.0.0。' ;;
esac

install_download_tools() {
  missing=''
  for command_name in curl unzip; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      missing="$missing $command_name"
    fi
  done
  [ -z "$missing" ] && return

  info '安装下载工具'
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl unzip
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y ca-certificates curl unzip
  elif command -v yum >/dev/null 2>&1; then
    yum install -y ca-certificates curl unzip
  else
    fail "缺少$missing，且无法识别系统包管理器。请先安装 curl、unzip 和 CA 证书。"
  fi
}

install_debian_docker_from_aliyun() {
  command -v apt-get >/dev/null 2>&1 || fail '缺少 apt-get，请先恢复系统包管理器。'
  distribution_codename=$(sed -n 's/^VERSION_CODENAME=//p' "$OS_RELEASE_FILE" | tail -n 1 | tr -d '"')
  case "$distribution_codename" in
    ''|*[!a-z0-9-]*) fail '无法识别系统版本代号，请检查 /etc/os-release 中的 VERSION_CODENAME。' ;;
  esac
  info "直接使用阿里云 Docker CE 镜像安装 Docker 与 Compose（$distribution_id ${distribution_codename}）"
  docker_key=$(mktemp "${TMPDIR:-/tmp}/box3-docker-key.XXXXXX")
  if ! curl --proto '=https' --tlsv1.2 --fail --location --retry 3 --retry-delay 2 \
    --connect-timeout 10 --max-time 60 \
    "https://mirrors.aliyun.com/docker-ce/linux/$distribution_id/gpg" -o "$docker_key"; then
    rm -f "$docker_key"
    fail '无法从阿里云镜像下载 Docker 仓库签名密钥，请检查服务器到 mirrors.aliyun.com 的连接。'
  fi
  if [ ! -s "$docker_key" ]; then
    rm -f "$docker_key"
    fail '阿里云 Docker 仓库签名密钥为空。'
  fi
  mkdir -p /etc/apt/keyrings /etc/apt/sources.list.d
  chmod 0755 /etc/apt/keyrings
  chmod a+r "$docker_key"
  mv "$docker_key" /etc/apt/keyrings/docker.asc
  printf '%s\n' \
    "deb [arch=$architecture signed-by=/etc/apt/keyrings/docker.asc] https://mirrors.aliyun.com/docker-ce/linux/$distribution_id $distribution_codename stable" \
    >/etc/apt/sources.list.d/docker.list
  if ! apt-get update; then
    fail '阿里云 Docker 镜像索引更新失败，请检查上方仓库日志。'
  fi
  if ! DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then
    fail '阿里云 Docker CE 安装失败，请检查上方依赖与软件包下载日志。'
  fi
}

install_alinux_docker() {
  distribution_major=${distribution_version%%.*}
  case "$distribution_major" in
    2) repository_suffix=''; repository_key='https://mirrors.aliyun.com/alinux/RPM-GPG-KEY-ALinux-7' ;;
    3) repository_suffix=''; repository_key='https://mirrors.aliyun.com/alinux/3/RPM-GPG-KEY-ALINUX-3' ;;
    4) repository_suffix='os/'; repository_key='https://mirrors.aliyun.com/alinux/4/RPM-GPG-KEY-ALINUX-4' ;;
    *) fail "暂未配置阿里云 Linux $distribution_version 的原生仓库，请先手动安装 Docker Engine 和 Compose v2。" ;;
  esac
  if command -v dnf >/dev/null 2>&1; then
    docker_package_manager=dnf
  elif command -v yum >/dev/null 2>&1; then
    docker_package_manager=yum
  else
    fail '阿里云 Linux 缺少 dnf 或 yum，请先恢复系统包管理器。'
  fi
  case "$architecture" in
    amd64) repository_architecture=x86_64 ;;
    arm64) repository_architecture=aarch64 ;;
  esac
  if [ "$distribution_major" = '3' ]; then
    info '使用阿里云 Docker CE 镜像安装 Docker 与 Compose，系统依赖使用阿里云 Linux 3 原生仓库'
  else
    info "使用阿里云 Linux $distribution_major 原生镜像仓库安装 Docker 与 Compose"
  fi
  # Temporary repo files work with both yum and dnf without extra plugins.
  # Fixed version URLs avoid the releasever adapter and its configured EPEL lookup.
  docker_repositories=$(mktemp -d "${TMPDIR:-/tmp}/box3-docker-repos.XXXXXX")
  for repository in os updates plus; do
    repository_id="box3-alinux$distribution_major-$repository"
    repository_url="https://mirrors.aliyun.com/alinux/$distribution_major/$repository/$repository_architecture/$repository_suffix"
    cat >"$docker_repositories/$repository_id.repo" <<EOF
[$repository_id]
name=BOX3 Alibaba Cloud Linux $distribution_major $repository
baseurl=$repository_url
enabled=1
gpgcheck=1
gpgkey=$repository_key
EOF
  done
  if [ "$distribution_major" = '3' ]; then
    cat >"$docker_repositories/box3-docker-ce.repo" <<EOF
[box3-docker-ce]
name=BOX3 Docker CE Aliyun Mirror
baseurl=https://mirrors.aliyun.com/docker-ce/linux/centos/8/$repository_architecture/stable
enabled=1
gpgcheck=1
gpgkey=https://mirrors.aliyun.com/docker-ce/linux/centos/gpg
EOF
    set -- docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    set -- docker docker-client containerd docker-compose-plugin
  fi
  # Plugins are skipped only for this temporary-repository invocation; package
  # GPG verification remains enabled and system plugin configuration is unchanged.
  if ! "$docker_package_manager" --noplugins "--setopt=reposdir=$docker_repositories" install -y "$@"; then
    rm -rf "$docker_repositories"
    fail "阿里云 Linux $distribution_major Docker 安装失败，请检查上方镜像仓库、依赖与包签名日志。"
  fi
  rm -rf "$docker_repositories"
}

install_docker_packages() {
  distribution_id=''
  distribution_version=''
  if [ -r "$OS_RELEASE_FILE" ]; then
    distribution_id=$(sed -n 's/^ID=//p' "$OS_RELEASE_FILE" | tail -n 1 | tr -d '"')
    distribution_version=$(sed -n 's/^VERSION_ID=//p' "$OS_RELEASE_FILE" | tail -n 1 | tr -d '"')
  fi
  case "$distribution_id" in
    alinux) install_alinux_docker ;;
    ubuntu|debian) install_debian_docker_from_aliyun ;;
    *) fail "暂未配置 $distribution_id 的阿里云 Docker 镜像安装流程，请先手动安装 Docker Engine 和 Compose v2。" ;;
  esac
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    docker_command=$(docker --version 2>&1 || true)
    if printf '%s' "$docker_command" | grep -qi podman; then
      fail '检测到 podman-docker 兼容命令，请先移除兼容包，再运行安装器安装真实 Docker Engine。'
    fi
    if ! docker compose version >/dev/null 2>&1; then
      install_docker_packages
    fi
  else
    install_docker_packages
  fi

  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker
  elif command -v service >/dev/null 2>&1; then
    service docker start
  fi

  docker info >/dev/null 2>&1 || fail 'Docker Engine 未正常运行，请检查 Docker 服务日志。'
  docker compose version >/dev/null 2>&1 || fail '缺少 Docker Compose v2 插件。'
}

resolve_version() {
  if [ "$REQUESTED_VERSION" != 'latest' ]; then
    version=${REQUESTED_VERSION#v}
  else
    if version=$(curl --proto '=https' --tlsv1.2 -fsSL \
      "${RELEASE_CDN_URL%/}/latest.txt"); then
      version=${version#v}
    else
      fail '无法从 CDN 获取发行版本，请检查网络或稍后重试。'
    fi
  fi
  case "$version" in
    ''|*[!0-9A-Za-z._-]*) fail '无法确定可安装的发行版本。' ;;
  esac
}

is_ipv4_address() {
  printf '%s\n' "$1" | awk -F. '
    NF == 4 {
      for (field = 1; field <= 4; field++) {
        if ($field !~ /^[0-9]+$/ || $field > 255) exit 1
      }
      exit 0
    }
    { exit 1 }
  '
}

detect_public_ipv4() {
  for endpoint in \
    https://api-ipv4.ip.sb/ip \
    https://ipv4.icanhazip.com; do
    candidate=$(curl --proto '=https' --tlsv1.2 --fail --location --retry 2 --retry-delay 1 \
      --max-time 5 "$endpoint" 2>/dev/null | tr -d '\r\n' || true)
    if is_ipv4_address "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

set_env_value() {
  key=$1
  value=$2
  if grep -q "^${key}=" .env; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" .env
    rm -f .env.bak
  else
    printf '%s=%s\n' "$key" "$value" >>.env
  fi
}

read_env_value() {
  key=$1
  [ -f "$INSTALL_DIRECTORY/.env" ] || return 0
  sed -n "s/^${key}=//p" "$INSTALL_DIRECTORY/.env" | tail -n 1
}

release_env_value() {
  key=$1
  sed -n "s/^${key}=//p" .env.example | tail -n 1
}

running_application_services() {
  [ -f "$INSTALL_DIRECTORY/.env" ] || return
  [ -f "$INSTALL_DIRECTORY/compose.yml" ] || return
  docker compose --env-file "$INSTALL_DIRECTORY/.env" \
    -f "$INSTALL_DIRECTORY/compose.yml" ps --services --filter status=running 2>/dev/null |
    while IFS= read -r service_name; do
      case "$service_name" in
        player-service|player-auth-portal|creator|play|voxa)
          printf '%s\n' "$service_name"
          ;;
      esac
    done
}

open_manager_firewall() {
  port=$1
  [ "$MANAGER_BIND_IP" = '0.0.0.0' ] || return
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow "${port}/tcp" >/dev/null
    info "已在 UFW 放行 TCP $port"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null
    firewall-cmd --reload >/dev/null
    info "已在 firewalld 放行 TCP $port"
  fi
}

existing_installation_matches_target() {
  [ -f "$INSTALL_DIRECTORY/.env" ] || return 1
  [ -f "$INSTALL_DIRECTORY/compose.yml" ] || return 1
  [ -x "$INSTALL_DIRECTORY/start.sh" ] || return 1

  installed_image_tag=$(sed -n 's/^BOX_IMAGE_TAG=//p' "$INSTALL_DIRECTORY/.env" | tail -n 1)
  installed_platform=$(sed -n 's/^BOX_PLAY_PLATFORM=//p' "$INSTALL_DIRECTORY/.env" | tail -n 1)
  expected_image_tag="v${version}-linux-${architecture}"
  [ "$installed_image_tag" = "$expected_image_tag" ] || return 1
  [ "$installed_platform" = "linux/${architecture}" ] || return 1

  docker image inspect "box-local-engine-server-manager:${expected_image_tag}" >/dev/null 2>&1 || return 1
}

install_download_tools
install_docker

resolve_version

package_name="BOX3-Engine-Server-$version-linux-$architecture"
package_url="${RELEASE_CDN_URL%/}/$package_name.zip"
temporary_directory=$(mktemp -d)
cleanup() {
  exit_status=$?
  trap - EXIT HUP INT TERM
  rm -rf "$temporary_directory"
  exit "$exit_status"
}
trap cleanup EXIT HUP INT TERM

info "下载 BOX3 Engine ${version}（linux/${architecture}）"
if ! curl --proto '=https' --tlsv1.2 --fail --location \
  --retry 3 --retry-delay 2 --output "$temporary_directory/package.zip" "$package_url"; then
  fail '无法从 CDN 下载服务器发行包，请检查网络或稍后重试。'
fi
unzip -q "$temporary_directory/package.zip" -d "$temporary_directory/unpacked"
package_directory="$temporary_directory/unpacked/$package_name"
[ -d "$package_directory" ] || fail '发行包目录结构无效。'

chmod +x "$package_directory"/*.sh
"$package_directory/verify.sh"

# A version can be repackaged with a newer manager. Compare the small package
# manifest before reusing local images, rather than trusting the version alone.
if existing_installation_matches_target && \
  cmp -s "$INSTALL_DIRECTORY/SHA256SUMS" "$package_directory/SHA256SUMS"; then
  info "检测到相同版本与内容，跳过镜像下载和更新，直接启动管理器"
  "$INSTALL_DIRECTORY/start.sh"
  exit 0
fi

# Remember only the packaged application services that are currently running.
# Databases, Redis and map runtime containers keep their own lifecycle and are
# never removed by the updater.
previously_running_services=$(running_application_services | tr '\n' ' ' || true)
previous_image_tag=$(read_env_value BOX_IMAGE_TAG)
previous_manager_image_id=''
if [ -n "$previous_image_tag" ]; then
  previous_manager_image_id=$(docker image inspect --format '{{.Id}}' \
    "box-local-engine-server-manager:$previous_image_tag" 2>/dev/null || true)
fi

info "安装到 $INSTALL_DIRECTORY"
mkdir -p "$INSTALL_DIRECTORY"
# The release package never contains .env, licences, maps, models or database
# data. Copying it over an existing installation upgrades executable files
# while preserving all operator-owned state in the stable install directory.
cp -a "$package_directory"/. "$INSTALL_DIRECTORY"/
chmod +x "$INSTALL_DIRECTORY"/*.sh

info '导入镜像并启动管理端'
cd "$INSTALL_DIRECTORY"
environment_backup=''
if [ -f .env ]; then
  environment_backup="$temporary_directory/environment.backup"
  cp .env "$environment_backup"
  new_image_tag=$(release_env_value BOX_IMAGE_TAG)
  new_play_platform=$(release_env_value BOX_PLAY_PLATFORM)
  [ -n "$new_image_tag" ] || fail '发行包缺少 BOX_IMAGE_TAG。'
  [ -n "$new_play_platform" ] || fail '发行包缺少 BOX_PLAY_PLATFORM。'
  set_env_value BOX_IMAGE_TAG "$new_image_tag"
  set_env_value BOX_PLAY_PLATFORM "$new_play_platform"
fi
if ! ./install.sh; then
  if [ -n "$environment_backup" ]; then
    cp "$environment_backup" .env
  fi
  fail '新版本安装失败，已恢复原配置。'
fi

# New server packages keep only manifests. Remove full archives left by older
# packages after the new manager image has been downloaded and verified.
rm -f "$INSTALL_DIRECTORY"/box-local-engine-images-v*-linux-*.tar.gz \
  "$INSTALL_DIRECTORY"/box3-engine-play-server-images-v*-linux-*.tar.gz

set_env_value BOX_SERVER_MANAGER_BIND_IP "$MANAGER_BIND_IP"
docker compose --env-file .env -f compose.yml up -d --no-build \
  --remove-orphans --force-recreate --wait server-manager

manager_port=$(read_env_value BOX_SERVER_MANAGER_PORT)
manager_port=${manager_port:-3130}
manager_token=$(read_env_value BOX_SERVER_MANAGER_TOKEN)
if [ -n "$previously_running_services" ]; then
  for service in player-service player-auth-portal creator voxa play; do
    case " $previously_running_services " in
      *" $service "*)
        info "通过 Web 管理器恢复 ${service}（缺少的镜像会按需下载）"
        if ! curl --silent --show-error --fail --retry 20 --retry-delay 2 --retry-connrefused \
          -H "Authorization: Bearer $manager_token" \
          -H 'Content-Type: application/json' \
          -d "{\"service\":\"$service\",\"action\":\"start\"}" \
          "http://127.0.0.1:$manager_port/api/commands/control_service" >/dev/null; then
          fail "恢复 $service 失败；请登录 Web 管理器查看状态后手动启动。"
        fi
        ;;
    esac
  done
fi
new_image_tag=$(read_env_value BOX_IMAGE_TAG)
if [ -n "$previous_image_tag" ] && [ "$previous_image_tag" != "$new_image_tag" ]; then
  for service in player-service player-auth-portal creator play voxa; do
    docker image rm "box-local-engine-$service:$previous_image_tag" >/dev/null 2>&1 || true
  done
  # The detached updater still runs from the old manager image; remove its old
  # tag now. Docker reclaims the layers after the helper exits.
  docker image rm --force "box-local-engine-server-manager:$previous_image_tag" >/dev/null 2>&1 || true
fi
if [ -n "${BOX3_UPDATE_HELPER_NAME:-}" ] && [ -n "$previous_manager_image_id" ]; then
  new_manager_image="box-local-engine-server-manager:$new_image_tag"
  new_manager_image_id=$(docker image inspect --format '{{.Id}}' "$new_manager_image" 2>/dev/null || true)
  if [ -n "$new_manager_image_id" ] && [ "$new_manager_image_id" != "$previous_manager_image_id" ]; then
    socket=$(read_env_value BOX_DOCKER_SOCKET)
    socket=${socket:-/var/run/docker.sock}
    cleanup_name="box3-image-cleanup-$$"
    cleanup_mount="type=bind,source=$socket,target=/var/run/docker.sock"
    docker run --detach --rm --name "$cleanup_name" --network host \
      --mount "$cleanup_mount" "$new_manager_image" /bin/sh -c '
        helper=$1
        old_image=$2
        while docker container inspect "$helper" >/dev/null 2>&1; do sleep 2; done
        docker image rm --force "$old_image" >/dev/null 2>&1 || true
      ' sh "$BOX3_UPDATE_HELPER_NAME" "$previous_manager_image_id" >/dev/null 2>&1 || true
  fi
fi
open_manager_firewall "$manager_port"
lan_ip=$(read_env_value BOX_LAN_IP)
if [ -z "$lan_ip" ] && command -v hostname >/dev/null 2>&1; then
  lan_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
fi
public_ip=${BOX3_PUBLIC_IP:-}
if [ -z "$public_ip" ]; then
  public_ip=$(detect_public_ipv4 || true)
fi
owner_token=$(read_env_value BOX_PLAY_ADMIN_TOKEN)

INSTALL_FINISHED_AT=$(date +%s)
INSTALL_ELAPSED_SECONDS=$((INSTALL_FINISHED_AT - INSTALL_STARTED_AT))
INSTALL_ELAPSED_MINUTES=$((INSTALL_ELAPSED_SECONDS / 60))
INSTALL_ELAPSED_REMAINDER=$((INSTALL_ELAPSED_SECONDS % 60))

printf '\n%s========================================================================%s\n' \
  "$COLOR_TITLE" "$COLOR_RESET"
printf '%s                    BOX3 Engine 面板账户登录信息%s\n' \
  "$COLOR_TITLE" "$COLOR_RESET"
printf '%s========================================================================%s\n' \
  "$COLOR_TITLE" "$COLOR_RESET"
printf '%s安装状态：%s%s安装成功%s\n' \
  "$COLOR_LABEL" "$COLOR_RESET" "$COLOR_SUCCESS" "$COLOR_RESET"
printf '%s安装目录：%s%s\n' "$COLOR_LABEL" "$COLOR_RESET" "$INSTALL_DIRECTORY"
if [ "$MANAGER_BIND_IP" = '0.0.0.0' ]; then
  printf '\n%s【云服务器】请在安全组放行 TCP %s 端口%s\n' \
    "$COLOR_LABEL" "$manager_port" "$COLOR_RESET"
  if [ -n "$public_ip" ]; then
    printf '外网 IPv4 面板地址：http://%s:%s\n' "$public_ip" "$manager_port"
  fi
  if [ -n "$lan_ip" ]; then
    printf '内网面板地址：     http://%s:%s\n' "$lan_ip" "$manager_port"
  fi
else
  printf '\n本机面板地址：http://127.0.0.1:%s\n' "$manager_port"
fi
if [ -z "${BOX3_WEB_UPDATE:-}" ]; then
  printf '\n%s管理端登录密钥：%s%s\n' "$COLOR_LABEL" "$COLOR_RESET" "$manager_token"
  printf '%s服主管理密钥：  %s%s\n' "$COLOR_LABEL" "$COLOR_RESET" "$owner_token"
  printf '\n请立即保存以上信息。密钥只应交给服主，不要截图或公开。\n'
else
  printf '\nWeb 管理器更新流程已完成。\n'
fi
printf '%s========================================================================%s\n' \
  "$COLOR_TITLE" "$COLOR_RESET"
printf '%s安装耗时：%s%d 分 %d 秒\n' \
  "$COLOR_SUCCESS" "$COLOR_RESET" "$INSTALL_ELAPSED_MINUTES" "$INSTALL_ELAPSED_REMAINDER"

if [ -n "${BOX3_UPDATE_HELPER_NAME:-}" ]; then
  docker rm -f "$BOX3_UPDATE_HELPER_NAME" >/dev/null 2>&1 || true
fi
)
