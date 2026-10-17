#!/usr/bin/env bash
# compat-check.sh — BOX3 地图兼容性回归检查（G3/G4 安全网）
#
# 目的：任何轻量化/瘦身/提速改动，都必须先通过本脚本，才允许落地。
# 原则：**只读取证**。不新建容器、不写业务数据、不改 git 状态、不联网下载。
#
# 运行位置：**必须在 WSL 内部**（脚本需要 bash + coreutils + gawk + curl + sha256sum；
#           WSL 里没有 node，所以全部检查用 shell/awk 实现，零依赖）。
# 从 Windows 调用（唯一可用姿势 —— 路径必须包在 bash -lc 的引号里，
# 否则 Git Bash 会把 /mnt/d/... 改写成 C:/Program Files/Git/mnt/... 而找不到文件）：
#   wsl -d Ubuntu-24.04 -- bash -lc 'bash "/mnt/d/desktop/神奇代码岛/box3-re/tools/compat-check.sh"'
# 直接在 Git Bash 里 `bash compat-check.sh` 会让 docker/http/map 三组探针全部取不到值，
# 本脚本据实判 PARTIAL（退出码 2），不判通过。
#
# 退出码：0=PASS（全部测到且与基线一致） 1=FAIL（真回归 / 检查项被删） 2=PARTIAL（有 N 项因环境未测）
#
# 用法：
#   compat-check.sh [选项]
#     --json                 以 JSON 输出结果（机器可读，CI 用）
#     --human                人类可读输出（默认）
#     --baseline <file>      基线文件（默认 <box3-re>/baseline/g3-baseline.tsv）
#     --update-baseline      把本次结果写成基线（并写 members 清单 + sha256）
#     --repo <dir>           源码仓根（默认自动定位 ../box3-local-engine）
#     --install <dir>        local-engine 数据根（默认现网安装目录，读不到则试 /var/tmp/w4-data）
#     --skip-http            不碰正在运行的容器（纯静态，任何时刻可跑 → 判 PARTIAL，不是 PASS）
#     --skip-docker          不执行 docker ps / docker inspect（同上）
#     --quiet                只输出汇总与失败项
#   环境变量：INSTALL_ROOT 指定数据根；PLAY_PORT 手动指定 play 端口（例：测 A3 的 lite 栈 4121）
set -uo pipefail
export LC_ALL=C.UTF-8

# ---------------------------------------------------------------- 参数
JSON=0; UPDATE=0; SKIP_HTTP=0; SKIP_DOCKER=0; QUIET=0; MODE=human
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
BOX3RE=$(dirname -- "$SCRIPT_DIR")
# 两种布局都要能用：
#   工作副本  box3-re/tools/…            → 源码仓在同级的 ../box3-local-engine
#   已合仓    box3-lite-engine/slim/tools/… → 源码仓就是 slim 的上一级（仓库根本身）
# 认根靠「有没有 packages/script-api/dts」这个真实锚点，不靠目录名猜。
_default_repo() {
  local c
  for c in "$(dirname -- "$BOX3RE")/box3-local-engine" "$(dirname -- "$BOX3RE")"; do
    [ -d "$c/packages/script-api/dts" ] && { printf '%s' "$c"; return 0; }
  done
  printf '%s' "$(dirname -- "$BOX3RE")/box3-local-engine"
}
REPO="${COMPAT_REPO:-$(_default_repo)}"
BASELINE="${COMPAT_BASELINE:-$BOX3RE/baseline/g3-baseline.tsv}"
MEMBERS_OUT="${COMPAT_MEMBERS:-$BOX3RE/baseline/contract-server-api.members.tsv}"

while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1; MODE=json; shift ;;
    --human) MODE=human; shift ;;
    --baseline) BASELINE="$2"; shift 2 ;;
    --update-baseline) UPDATE=1; shift ;;
    --repo) REPO="$2"; shift 2 ;;
    --install) INSTALL_ROOT="$2"; shift 2 ;;
    --skip-http) SKIP_HTTP=1; shift ;;
    --skip-docker) SKIP_DOCKER=1; shift ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "compat-check.sh: 未知参数: $1" >&2; exit 2 ;;
  esac
done

DTS="$REPO/packages/script-api/dts/box3-server-api.d.ts"
DTS_CLIENT="$REPO/packages/script-api/dts/client-api-types.dts"
APIJS="$REPO/internals/schema/api/js"

# ---------------------------------------------------------------- 环境前置
# 契约指纹取决于 sort/awk 的 locale 与实现。实测：同一份 dts，Git Bash（gawk 5.4.0、
# 无 C.UTF-8 locale）与 WSL（gawk 5.2.1）算出**不同的 sha256** → 一份代码两种红绿。
# 这种闸不可信，所以直接拒绝在非 Linux 上出结论，而不是给一个可疑的判定。
OSNAME=$(uname -s 2>/dev/null || echo unknown)
if [ "$OSNAME" != Linux ]; then
  {
    echo "compat-check.sh: 拒绝执行 —— 运行环境 uname=$OSNAME，本脚本只支持 WSL/Linux。"
    echo "  原因：sort/awk 的 locale 实现不同，同一份源码会算出不同的契约指纹（假红/假绿都可能）。"
    echo "  调用式：wsl -d Ubuntu-24.04 -- bash -lc 'bash \"<mnt 路径>/box3-re/tools/compat-check.sh\"'"
  } >&2
  exit 1
fi

# ---------------------------------------------------------------- 结果容器
# RESULT_TSV: 每行  key \t value \t status \t detail
RESULT_TSV=$(mktemp); trap 'rm -f "$RESULT_TSV" "${REQ_TSV:-}"' EXIT
FAILS=0; SKIPS=0; PASSES=0
# GATED：因「环境跑不到」而整组未测的 key 前缀（http. / topo. / map.）。
# 探针跑不到 ≠ 检查项被删，这两类必须分开：否则安全网会一次造出几十条假红，
# 而一旦大家开始无视红，它就再也守不住任何回归。
GATED=""
gate() { GATED="$GATED $1"; }

record() { # key value status detail
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$RESULT_TSV"
  case "$3" in
    fail) FAILS=$((FAILS+1)) ;;
    skip) SKIPS=$((SKIPS+1)) ;;
    pass) PASSES=$((PASSES+1)) ;;
  esac
}

# ---------------------------------------------------------------- 工具
sha_of() { sha256sum 2>/dev/null | cut -c1-64; }

# 契约成员清单：把 .d.ts 里每个「成员声明行」归入互斥的桶，并带上所属顶层声明名。
# 桶定义（顺序即优先级，一行只进一个桶）—— 全部是行级正则，因为
# box3-server-api.d.ts 由 fix-declaration.js 生成，实测它把 GameWorld 的整段成员列表
# 塞进了一个不闭合的 `constructor(`（见文件第 1065 行），任何括号配平的 AST 式解析
# 都会在那里塌掉、少算 50+ 个成员。行级分类对这个缺陷免疫。
# 输出： bucket \t owner \t normalized-line
contract_members() { # $1 = dts path
  awk '
    { if ($0 ~ /^[^[:space:]]/) {
        if (match($0, /^[[:space:]]*(export[[:space:]]+)?(declare[[:space:]]+)?(abstract[[:space:]]+)?(class|interface|const|let|var|function|enum|namespace)[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*/)) {
          t = substr($0, RSTART, RLENGTH); sub(/.*[[:space:]]/, "", t); owner = t
        }
      }
      ind=$0; sub(/^[[:space:]]+/, "", ind)
      if (ind == "" || ind ~ /^\*/ || ind ~ /^\/\//) next
      o = (owner == "" ? "<global>" : owner)
      if (ind ~ /^[A-Za-z_$][A-Za-z0-9_$]*\??\(/)                       { if (ind ~ /^constructor\(/) b="ctor"; else b="method"; print b "\t" o "\t" ind; next }
      if (ind ~ /^[A-Za-z_$][A-Za-z0-9_$]*\??[[:space:]]*:[[:space:]]*\(/) { print "arrow\t" o "\t" ind; next }
      if (ind ~ /^(get|set)[[:space:]]+/)                               { print "accessor\t" o "\t" ind; next }
      if (ind ~ /^\[/)                                                  { print "index\t" o "\t" ind; next }
      if (ind ~ /^[<(]/)                                                { print "callsig\t" o "\t" ind; next }
      if (ind ~ /^[A-Za-z_$][A-Za-z0-9_$]*\??[[:space:]]*:/)            { print "prop\t" o "\t" ind; next }
      print "other\t" o "\t" ind
    }' "$1"
}

bucket_count() { contract_members "$1" | cut -f1 | sort | uniq -c | awk -v w="$2" '$2==w{print $1}' ; }

# ================================================================ L0 / L4：契约指纹
check_contract() {
  if [ ! -f "$DTS" ]; then record "contract.server.dts.exists" "-" fail "$DTS 不存在 → 无法建立 G4 锚"; return; fi
  local n; n=$(awk 'END{print NR}' "$DTS")
  record "contract.server.dts.lines" "$n" pass "行数（出厂基线 4603）"

  local m ctor arrow acc idx cs prop callable semantic doc_formula
  m=$(bucket_count "$DTS" method);        m=${m:-0}
  ctor=$(bucket_count "$DTS" ctor);       ctor=${ctor:-0}
  arrow=$(bucket_count "$DTS" arrow);     arrow=${arrow:-0}
  acc=$(bucket_count "$DTS" accessor);    acc=${acc:-0}
  idx=$(bucket_count "$DTS" index);       idx=${idx:-0}
  cs=$(bucket_count "$DTS" callsig);      cs=${cs:-0}
  prop=$(bucket_count "$DTS" prop);       prop=${prop:-0}

  # ANALYSIS-AND-PLAN.md §3.4 的「398 个可调用」= 183 method-style + 215 prop-arrow-fn。
  # 实测复现（method 桶已把 constructor 拆出，故 method-style = method + ctor）：
  #   method-style = method(98) + ctor(52) + accessor(23) + index(10) = 183
  #   prop-arrow   = arrow(204) + callsig(11)                          = 215
  #   合计                                                          = 398
  doc_formula=$(( m + ctor + acc + idx + arrow + cs ))
  # 语义上「作者脚本真能调用」的面：不含 ctor，不含 index signature，含 callsig
  semantic=$(( m + arrow + cs ))

  record "contract.server.doc398.formula" "$doc_formula" "$( [ "$doc_formula" = 398 ] && echo pass || echo fail )" "ANALYSIS-AND-PLAN §3.4 宣称 398；本桶定义下实测 $doc_formula"
  record "contract.server.doc398.methodStyle" "$(( m + ctor + acc + idx ))" "$( [ "$(( m + ctor + acc + idx ))" = 183 ] && echo pass || echo fail )" "宣称 183（含 ctor/accessor/index，口径见文档）"
  record "contract.server.doc398.arrowStyle" "$(( arrow + cs ))" "$( [ "$(( arrow + cs ))" = 215 ] && echo pass || echo fail )" "宣称 215"
  record "contract.server.callable.semantic" "$semantic" pass "语义口径：method($m)+arrow($arrow)+callsig($cs)，剔除 ctor($ctor)/index($idx)/accessor($acc)"
  record "contract.server.bucket.method" "$m" pass "name( 形式"
  record "contract.server.bucket.ctor" "$ctor" pass "constructor( —— 是 new 位点，不是成员可调用"
  record "contract.server.bucket.arrow" "$arrow" pass "name: ( 形式"
  record "contract.server.bucket.accessor" "$acc" warn "get/set —— 按属性访问，不是可调用；在 398 与 1234 两个桶里被重复计入"
  record "contract.server.bucket.index" "$idx" warn "[k: T] 索引签名，不是可调用"
  record "contract.server.bucket.callsig" "$cs" pass "匿名调用签名"
  record "contract.server.bucket.prop" "$prop" pass "普通属性"

  # 指纹：全量成员行排序后的 sha256。任何 API 面增减都会变。
  local fp; fp=$(contract_members "$DTS" | sort | sha_of)
  record "contract.server.fingerprint.sha256" "$fp" pass "成员清单指纹（G4 回归锚）"
  if [ -f "$MEMBERS_OUT" ]; then
    local fpf; fpf=$(sort "$MEMBERS_OUT" | sha_of)
    if [ "$fpf" = "$fp" ]; then record "contract.server.members.matchFile" "yes" pass "$MEMBERS_OUT"
    else record "contract.server.members.matchFile" "no" fail "入库成员清单与实测 dts 不一致"; fi
  else
    record "contract.server.members.matchFile" "absent" skip "$MEMBERS_OUT 尚未生成（跑 --update-baseline）"
  fi

  # 客户端契约面（已知断链：apps/game/client-api-tsconfig.json 的 include 有一半指向不存在的路径）
  if [ -f "$DTS_CLIENT" ]; then
    local cm ca cc ci cg
    cm=$(bucket_count "$DTS_CLIENT" method);     cm=${cm:-0}
    ca=$(bucket_count "$DTS_CLIENT" arrow);      ca=${ca:-0}
    cc=$(bucket_count "$DTS_CLIENT" callsig);    cc=${cc:-0}
    ci=$(bucket_count "$DTS_CLIENT" index);      ci=${ci:-0}
    cg=$(bucket_count "$DTS_CLIENT" accessor);   cg=${cg:-0}
    local cctor; cctor=$(bucket_count "$DTS_CLIENT" ctor); cctor=${cctor:-0}
    cfp=$(contract_members "$DTS_CLIENT" | sort | sha_of)
    record "contract.client.dts.lines" "$(awk 'END{print NR}' "$DTS_CLIENT")" pass ""
    record "contract.client.doc398formula" "$(( cm + cctor + ca + cc + ci + cg ))" warn "文档称客户端声明面 32 个可调用；实测 method-style=$(( cm + cctor ))、arrow-style=$(( ca + cc ))、合计 $(( cm + cctor + ca + cc + ci + cg ))（客户端 DTS 已无法再生成，见 brokenInclude）"
    record "contract.client.fingerprint.sha256" "$cfp" pass ""
  else
    record "contract.client.fingerprint.sha256" "-" fail "client-api-types.dts 缺失"
  fi

  # 断链取证：client tsconfig 的两条 include 各自是否命中真实文件。
  # 这是「永久已知红」，不是回归信号：客户端 DTS 冻结不影响已导出地图在服务端运行
  # （作者脚本在导出期已编译进 .boxplay），但它挡住 G4「客户端面再生成」这一步，
  # 修法是 1 行：src/engine/script/apis/*.ts → src/engine/script/ses/apis/*.ts（实测真源在此）。
  local tsc="$REPO/apps/game/client-api-tsconfig.json"
  if [ -f "$tsc" ]; then
    local dead=""
    [ -e "$REPO/apps/game/src/engine/script/apis" ] || dead="$dead src/engine/script/apis/*.ts"
    [ -e "$REPO/internals/schema/api/common.ts" ] || dead="$dead ../../internals/schema/api/common.ts"
    local nd; nd=$(printf '%s' "$dead" | wc -w)
    if [ "$nd" -gt 0 ]; then
      record "contract.client.tsconfig.brokenInclude" "$nd" warn "已知红（非回归信号）：$tsc 的 include 有 $nd/2 条不存在:$dead → 客户端 DTS 无法再生成"
    else
      record "contract.client.tsconfig.brokenInclude" "0" pass ""
    fi
    # 真实客户端 API 源位置（修 include 时的目标路径），只读取证
    if [ -d "$REPO/apps/game/src/engine/script/ses/apis" ]; then
      record "contract.client.realApiDir" "$(ls "$REPO/apps/game/src/engine/script/ses/apis"/*.ts 2>/dev/null | wc -l | tr -d '[:space:]')" pass "apps/game/src/engine/script/ses/apis/*.ts 实测文件数"
    fi
  fi
}

# ================================================================ L4：契约面逐项有实现
# 静态口径：dts 里每个可调用成员名，必须能在实现真源 internals/schema/api/js/*.ts 里出现。
# 例外：注入全局宿主实现的 owner 不在 api schema 真源里，属已知正常，
# 单列计数、不计入分母。实测出处：
#   console.*    -> apps/game/src/engine/script/ses/apis/console.ts:11（沙箱注入宿主 console）
#   GameConsole  -> 同上，dts 第 7/50 行的声明，非 internals/schema/api/js 生成
HOST_OWNERS="GameConsole console"
is_host_owner() { case " $HOST_OWNERS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

check_impl_coverage() {
  if [ ! -d "$APIJS" ]; then record "impl.apijs.dir" "-" fail "$APIJS 不存在 → L4 静态覆盖度无法计算"; return; fi
  local tmp; tmp=$(mktemp)
  cat "$APIJS"/*.ts > "$tmp" 2>/dev/null
  local rows="" hosts=0
  rows=$(contract_members "$DTS" | awk -F'\t' '$1=="method"||$1=="arrow"||$1=="ctor"{n=$3; sub(/[[:space:]]*\(.*/,"",n); sub(/[[:space:]]*\??[[:space:]]*:.*/,"",n); gsub(/[[:space:]]/,"",n); if(n!=""&&n!="constructor") print $2"\t"n}')
  local pairs="" excl="" missing=0 misslist="" total=0
  while IFS=$'\t' read -r own nm; do
    [ -z "$nm" ] && continue
    if is_host_owner "$own"; then hosts=$((hosts+1)); excl="$excl $own.$nm"; continue; fi
    pairs="$pairs$own	$nm
"; total=$((total+1))
  done <<< "$rows"
  pairs=$(printf '%s' "$pairs" | sort -u)
  total=$(printf '%s\n' "$pairs" | grep -c '[^[:space:]]')
  while IFS=$'\t' read -r own nm; do
    [ -z "$nm" ] && continue
    if ! grep -qw -- "$nm" "$tmp"; then
      missing=$((missing+1)); [ ${#misslist} -lt 400 ] && misslist="$misslist $own.$nm"
    fi
  done <<< "$pairs"
  rm -f "$tmp"
  if [ "$missing" -eq 0 ]; then
    record "impl.coverage.missing" "0" pass "$total 个去重可调用 owner.name 全部在实现真源出现"
  else
    record "impl.coverage.missing" "$missing" fail "$total 个中 $missing 个在 $APIJS 找不到 → 疑似实现被 prune 误删:$misslist"
  fi
  record "impl.coverage.distinctPairs" "$total" pass "口径：owner.name 去重后的词级存在性；严格签名比对需要 node+tsc"
  record "impl.coverage.hostExcluded" "$hosts" pass "注入全局宿主面（不计入分母）:$excl"
  record "impl.coverage.implFiles" "$(ls "$APIJS"/*.ts 2>/dev/null | wc -l | tr -d '[:space:]')" pass "internals/schema/api/js/*.ts 文件数"
}

# ================================================================ L0：模块可解析（无需 node）
# 对「瘦身/挪 devDep/prune」最直接的静态杀伤检测：入口文件 require 的位点，
# 在磁盘上是否还能解析。等价于 MODULE_NOT_FOUND 预言机（WSL 内没有 node，无法真跑，
# 所以这里做纯静态解析；相对路径 + 外部裸包解析不到 = 红）。
# 三类位点分开统计：
#   relative  ./x、../x        —— 剪掉 dist 里任何文件都会红（最敏感）
#   external  裸包名           —— typescript 之类挪进 devDep 或被 prune 会红
#   workspace @box/*           —— 需要 /app 的工作区布局；本地副本缺 packages/ 时记 SKIP
NODE_BUILTIN='^(node:)?(fs|path|http|https|os|crypto|url|zlib|util|net|tls|stream|events|child_process|cluster|tty|string_decoder|assert|buffer|querystring|worker_threads|v8|module|perf_hooks|async_hooks|dgram|dns|readline|repl|trace_events|vm|timers|constants|punycode|test_runner)$'

check_module_resolution() {
  local roots=""
  [ -d "${APP_ROOT:-}" ] && roots="$roots $APP_ROOT"
  [ -d "/var/tmp/re-arch/creator-services/game-server" ] && roots="$roots /var/tmp/re-arch/creator-services/game-server"
  if [ -z "${roots// }" ]; then
    record "l0.moduleResolution.status" "-" skip "无本地 /app 副本可扫：--app-root <dir>（容器内 /app 的副本）"
    gate "l0."; return
  fi
  local rel_unres=0 ext_unres=0 ws_unres=0 ws_known=0 scanned=0 worst=""
  for R in $roots; do
    # 工作区根：含 packages/ 或 services/ 或 node_modules/@box 的最近祖先
    local WSROOT="" d="$R"
    while [ "$d" != "/" ]; do
      if [ -d "$d/node_modules/@box" ] || [ -d "$d/packages" ]; then WSROOT="$d"; break; fi
      d=$(dirname "$d")
    done
    [ -n "$WSROOT" ] && ws_known=1
    for E in "$R/dist/src/entry.js" "$R/src/launcher.js" "$R/launcher.js"; do
      [ -f "$E" ] || continue
      scanned=$((scanned+1))
      local ed specs s
      ed=$(dirname "$E")
      specs=$(grep -ohE 'require\(["'"'"'][^"'"'"']+["'"'"']\)' "$E" 2>/dev/null | sed -E 's/^require\(["'"'"']//; s/["'"'"']\)$//' | sort -u)
      [ -z "$specs" ] && continue
      while IFS= read -r s; do
        [ -z "$s" ] && continue
        printf '%s' "$s" | grep -qE "$NODE_BUILTIN" && continue
        case "$s" in
          .*)
            base="$ed/${s#./}"
            if [ ! -e "$base" ] && [ ! -e "$base.js" ] && [ ! -e "$base.json" ] && [ ! -e "$base/index.js" ]; then
              rel_unres=$((rel_unres+1)); worst="$worst REL:$E<-$s"
            fi ;;
          @box/*)
            pkg=${s#@box/}; pkg=${pkg%%/*}
            found=""
            for cand in "$R/node_modules/@box/$pkg" "$WSROOT/node_modules/@box/$pkg" "$WSROOT/packages/$pkg" "$WSROOT/services/$pkg" "$WSROOT/apps/$pkg"; do
              [ -e "$cand" ] && { found=1; break; }
            done
            [ -n "$found" ] || { ws_unres=$((ws_unres+1)); worst="$worst WS:$E<-$s"; } ;;
          *)
            found=""
            for cand in "$R/node_modules/$s" "$WSROOT/node_modules/$s"; do
              [ -e "$cand" ] && { found=1; break; }
            done
            [ -n "$found" ] || { ext_unres=$((ext_unres+1)); worst="$worst EXT:$E<-$s"; } ;;
        esac
      done <<< "$specs"
    done
  done
  record "l0.moduleResolution.entries" "$scanned" pass "扫描入口数：$roots"
  record "l0.moduleResolution.relativeUnresolved" "$rel_unres" "$( [ "$rel_unres" -eq 0 ] && echo pass || echo fail )" "相对位点解析失败 → dist 文件被剪"
  record "l0.moduleResolution.externalUnresolved" "$ext_unres" "$( [ "$ext_unres" -eq 0 ] && echo pass || echo fail )" "裸包解析失败 → 运行时依赖被 prune / 误挪 devDep"
  if [ "$ws_known" = 1 ]; then
    record "l0.moduleResolution.workspaceUnresolved" "$ws_unres" "$( [ "$ws_unres" -eq 0 ] && echo pass || echo fail )" "@box/* 工作区包（已找到工作区根）"
  else
    record "l0.moduleResolution.workspaceUnresolved" "$ws_unres" skip "本地副本无 node_modules/@box 或 packages/ 布局 → 该项需对容器内 /app 副本或 --app-root 才有效"
  fi
  [ -n "$worst" ] && record "l0.moduleResolution.samples" "$(printf '%s' "$worst" | cut -c1-300)" warn "未解析样本"
}

# ================================================================ L2：地图资产清单
digest_dir() { # $1 = dir -> files<TAB>bytes<TAB>sha256(relpath|size list)
  local d="$1"
  [ -d "$d" ] || { echo "0	0	EMPTY"; return; }
  local files bytes list
  files=$(find "$d" -type f 2>/dev/null | wc -l | tr -d '[:space:]')
  bytes=$(find "$d" -type f -printf '%s\n' 2>/dev/null | awk '{t+=$1} END{printf "%d", t+0}')
  list=$(cd "$d" && find . -type f -printf '%s\t%p\n' 2>/dev/null | sort | sha_of)
  printf '%s\t%s\t%s' "${files:-0}" "${bytes:-0}" "${list:-EMPTY}"
}

check_map_inventory() {
  # 定位现网安装目录：优先真实安装目录，退回 A4 泳道的本地副本
  local IW="" IP=""
  for cand in "${INSTALL_ROOT:-}" "/root/box3/BOX3-Engine-Server-0.2.0-linux-amd64/apps/local-engine" "/var/tmp/w4-data/apps/local-engine"; do
    if [ -n "$cand" ] && [ -d "$cand/play-worlds" ]; then IW="$cand/play-worlds"; IP="$cand/projects"; break; fi
  done
  if [ -z "$IW" ]; then
    # 分两种情况，别把「跑错地方」当成「地图没了」：
    # docker 不可达 → 多半是在 Windows 侧跑的（/root/box3、/var/tmp 都是 WSL 内路径）→ 环境未测；
    # docker 可达却仍找不到 → 这是真信号，G3 失去回归素材，必须红。
    if [ "$SKIP_DOCKER" = 1 ] || ! command -v docker >/dev/null 2>&1 || [ -z "$(docker ps -q 2>/dev/null | tr -d '\000')" ]; then
      record "map.playWorldsRoot" "-" skip "找不到 play-worlds 根目录，且 docker 不可达 → 须在 WSL 内跑本脚本（map.* 整组未测）"
      gate "map."; return
    fi
    record "map.playWorldsRoot" "-" fail "docker 可达却找不到任何 play-worlds 根目录 → G3 无回归素材（检查 INSTALL_ROOT，或现网数据卷是否被回收）"; gate "map."; return
  fi
  record "map.playWorldsRoot" "$IW" pass ""

  local n=0
  for w in "$IW"/*/; do
    [ -d "$w" ] || continue
    n=$((n+1))
    local id I3 digest f b s pub
    id=$(basename "$w")
    digest=$(digest_dir "$w"); f=$(printf '%s' "$digest" | cut -f1); b=$(printf '%s' "$digest" | cut -f2); s=$(printf '%s' "$digest" | cut -f3)
    record "map.world.$id.files" "$f" pass "字节=$b"
    record "map.world.$id.digest" "$s" pass "relpath|size 清单指纹"
    pub="$w/manifest.json"
    if [ -f "$pub" ]; then
      local keys; keys=$(grep -oE '"[A-Za-z][A-Za-z0-9_]*"[[:space:]]*:' "$pub" | sed -E 's/^"//; s/"[[:space:]]*:$//' | sort -u | tr '\n' ',' | sed 's/,$//')
      record "map.world.$id.manifestKeys" "${keys:-NONE}" "$( [ -n "$keys" ] && echo pass || echo fail )" "元数据字段不得丢失"
      record "map.world.$id.manifest.sha256" "$(sha_of < "$pub")" pass ""
    else
      record "map.world.$id.manifestKeys" "-" fail "manifest.json 丢失 → 该图不可发布"
    fi
    # 脚本 blob：内容寻址，无扩展名，用 onPlayerJoin 命中识别
    local sb; sb=$(grep -rl "onPlayerJoin" "$w" 2>/dev/null | wc -l | tr -d '[:space:]')
    record "map.world.$id.scriptBlobs" "${sb:-0}" "$( [ "${sb:-0}" -gt 0 ] && echo pass || echo fail )" "含 onPlayerJoin 的 blob 数（G3 判据的执行前提）"
  done
  record "map.playWorlds.count" "$n" "$( [ "$n" -ge 1 ] && echo pass || echo fail )" "可回归的已发布地图数"

  # creator 工程（未发布，仅可静态比对）
  if [ -d "$IP" ]; then
    local pn=0
    for p in "$IP"/*/; do
      [ -d "$p" ] || continue
      pn=$((pn+1))
      local pid pd pf pb ps
      pid=$(basename "$p"); pd=$(digest_dir "$p"); pf=$(printf '%s' "$pd" | cut -f1); pb=$(printf '%s' "$pd" | cut -f2); ps=$(printf '%s' "$pd" | cut -f3)
      record "map.project.$pid.files" "$pf" pass "字节=$pb"
      record "map.project.$pid.digest" "$ps" pass "未发布工程：只能做静态比对，不能单独当 G3 判据"
    done
    record "map.projects.count" "$pn" pass ""
  fi

  # 脚本 blob 总量（跨全部素材），这是 G4「真实用例覆盖面」的分母
  local jb; jb=$(grep -rl "onPlayerJoin" "$(dirname "$IW")" 2>/dev/null | wc -l | tr -d '[:space:]')
  record "map.scriptBlobs.total" "${jb:-0}" pass "全素材中含 onPlayerJoin 的 blob 总数"
}

# ================================================================ L2/L3：只读 HTTP
http_get() { # url -> code \t sha256 \t bytes
  local body code
  body=$(curl -sS --max-time 8 -w '\n%{http_code}' "$1" 2>/dev/null) || { printf -- '	ERR	0'; return; }
  code=$(printf '%s' "$body" | tail -n 1)
  local payload; payload=$(printf '%s' "$body" | sed '$d')
  printf '%s\t%s\t%s' "$code" "$(printf '%s' "$payload" | sha_of)" "$(printf '%s' "$payload" | wc -c | tr -d '[:space:]')"
}

check_http() {
  [ "$SKIP_HTTP" = 1 ] && { record "http.skipped" "true" skip "--skip-http"; gate "http."; return; }
  # 端口发现：不硬编码，从 docker inspect 拿现网实际发布端口（只读）
  local ports=""
  if [ "$SKIP_DOCKER" != 1 ] && command -v docker >/dev/null 2>&1; then
    ports=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | tr -d '\000')
  fi
  local play="" creator=""
  if [ -n "$ports" ]; then
    play=$(printf '%s\n' "$ports" | awk '/box-local-engine-play-1/{for(i=1;i<=NF;i++) if($i ~ /^127\.0\.0\.1:.*->3000/) {gsub(/^127\.0\.0\.1:|->.*/,"",$i); print $i; exit}}')
    creator=$(printf '%s\n' "$ports" | awk '/box-local-engine-creator-1/{for(i=1;i<=NF;i++) if($i ~ /^127\.0\.0\.1:.*->3000/) {gsub(/^127\.0\.0\.1:|->.*/,"",$i); print $i; exit}}')
  fi
  # 显式覆盖优先（例：测 A3 的 lite 栈时 PLAY_PORT=4121）
  [ -z "$play" ] && [ -n "${PLAY_PORT:-}" ] && play="$PLAY_PORT"
  # 发现不了端口 = 环境跑不到（脚本须在 WSL 内执行；Windows 侧的 docker CLI 看不见 WSL 里的容器），
  # 不是回归。整组门控为未测，末尾判 PARTIAL，绝不报绿。
  if [ -z "$play" ]; then
    record "http.skipped" "true" skip "未能从 docker 发现 play 的 127.0.0.1:3000 发布端口 → http.* 整组未测（本脚本须在 WSL 内跑：wsl -d Ubuntu-24.04 -- bash -lc 'bash \"/mnt/d/…/compat-check.sh\"'）"
    gate "http."; return
  fi

  local r code sha bytes
  r=$(http_get "http://127.0.0.1:$play/api/health-check"); code=$(printf '%s' "$r" | cut -f1); sha=$(printf '%s' "$r" | cut -f2)
  record "http.health.play.code" "${code:-ERR}" "$( [ "${code:-}" = 200 ] && echo pass || echo fail )" "GET /api/health-check @127.0.0.1:$play"
  record "http.health.play.body.sha256" "${sha:-ERR}" pass ""

  r=$(http_get "http://127.0.0.1:$play/api/play-worlds"); code=$(printf '%s' "$r" | cut -f1); sha=$(printf '%s' "$r" | cut -f2); bytes=$(printf '%s' "$r" | cut -f3)
  record "http.playWorlds.code" "${code:-ERR}" "$( [ "${code:-}" = 200 ] && echo pass || echo fail )" "L2 核心判据"
  record "http.playWorlds.body.sha256" "${sha:-ERR}" pass "响应体字节校验和：瘦身改动前后必须逐字节相同（A4 泳道做法，此处标准化）"
  record "http.playWorlds.body.bytes" "${bytes:-0}" pass ""

  if [ "${code:-}" = 200 ]; then
    local body; body=$(curl -sS --max-time 8 "http://127.0.0.1:$play/api/play-worlds" 2>/dev/null)
    local ids; ids=$(printf '%s' "$body" | grep -oE '"publicId":"[^"]+"' | sed 's/.*:"//; s/"$//' | sort | tr '\n' ',' | sed 's/,$//')
    record "http.playWorlds.publicIds" "${ids:-NONE}" "$( [ -n "$ids" ] && echo pass || echo fail )" "地图集合不得缩水"
    local mk; mk=$(printf '%s' "$body" | grep -oE '"[A-Za-z][A-Za-z0-9_]*":' | tr -d '":' | sort -u | tr '\n' ',' | sed 's/,$//')
    record "http.playWorlds.fields" "$mk" pass "字段集合：元数据字段丢失即红"
    local pe; pe=$(printf '%s' "$body" | grep -c '"playEnabled":true')
    record "http.playWorlds.playEnabledTrue" "$pe" "$( [ "$pe" -ge 1 ] && echo pass || echo fail )" "至少 1 张图处于开放状态"
  fi
}

# ================================================================ L1：容器/端口/挂载指纹
check_topology() {
  if [ "$SKIP_DOCKER" = 1 ] || ! command -v docker >/dev/null 2>&1; then
    record "topo.status" "-" skip "无 docker 或 --skip-docker"; gate "topo."; return
  fi
  local ps; ps=$(docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}' 2>/dev/null | tr -d '\000' | sort)
  if [ -z "$ps" ]; then record "topo.containerList.digest" "-" skip "docker 不可达"; gate "topo."; return; fi
  record "topo.runningCount" "$(printf '%s\n' "$ps" | grep -c .)" pass "现网运行容器数（只读，不 stop/start）"
  record "topo.containerList.digest" "$(printf '%s\n' "$ps" | sha_of)" pass "name|image|ports 指纹：端口/镜像/容器增减都会变"

  # 特权面指纹：docker.sock 挂载 + user:0:0（G5 联动，也是「去 docker.sock」改动的验收项）
  local sock=0 users=0 mounts
  mounts=$(docker ps -q 2>/dev/null | tr -d '\000' | while read -r c; do
             docker inspect "$c" --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}' 2>/dev/null
           done)
  sock=$(printf '%s\n' "$mounts" | grep -c 'docker\.sock')
  record "topo.dockerSockMounts" "${sock:-0}" pass "挂载 docker.sock 的运行容器数（只读 inspect）"
  users=$(docker ps -q 2>/dev/null | tr -d '\000' | while read -r c; do
             docker inspect "$c" --format '{{.Config.User}}{{println}}' 2>/dev/null
           done | grep -c '^0:0')
  record "topo.userZeroZero" "${users:-0}" pass "user:\"0:0\" 的运行容器数"
  record "topo.mountList.digest" "$(printf '%s\n' "$mounts" | sort | sha_of)" pass "全部挂载指纹：动 volume/删挂载一定变"
}

# ================================================================ 基线比对
compare_baseline() {
  if [ ! -f "$BASELINE" ]; then
    # 没有基线就无从判回归。以前的 skip + 末尾照样打 PASS —— 那是最危险的一种假绿：
    # 换了机器、挪了目录、基线没生成，闸会"全绿放行"。现在按 fail 处理，只有显式建基线时才放过。
    if [ "$UPDATE" = 1 ]; then
      record "baseline.exists" "absent" skip "首次运行：本次结果将写成基线，无回归可比"
      return 0
    fi
    record "baseline.exists" "absent" fail "$BASELINE 不存在 → 无法判回归（确认无误后跑 --update-baseline 建基线）"
    return 0
  fi
  record "baseline.exists" "present" pass "$BASELINE"
  local drift=0 gated=0
  while IFS=$'\t' read -r k v rest; do
    [ -z "$k" ] && continue
    # 元信息项：它们的值在「写基线的那次运行」和之后任何一次运行之间必然变化，不参与比对
    case "$k" in
      drift.*|baseline.exists|contract.server.members.matchFile|http.skipped|topo.status|map.playWorldsRoot) continue ;;
    esac
    # 同时取值与状态：以前只看值，于是「本次记为 skip 的项」被当成"值变了"报红 —— 假红的主要来源。
    local cur curst
    cur=$(awk -F'\t' -v K="$k" '$1==K{print $2; exit}' "$RESULT_TSV")
    curst=$(awk -F'\t' -v K="$k" '$1==K{print $3; exit}' "$RESULT_TSV")
    if [ -z "$curst" ]; then
      # 该项这次根本没被记录：分「整组被环境门控」与「检查项真的被删」两种
      local g hit=0
      for g in $GATED; do case "$k" in "$g"*) hit=1; break ;; esac; done
      if [ "$hit" = 1 ]; then
        record "drift.$k" "NOT_MEASURED" skip "该项属被环境门控的组（$GATED）→ 本次未测，不作回归判据，但整体只判 PARTIAL"
        gated=$((gated+1))
      else
        record "drift.$k" "MISSING_NOW" fail "基线里有、本次没测到、且不属于任何被门控的组 → 检查项被删"; drift=$((drift+1))
      fi
    elif [ "$curst" = skip ]; then
      record "drift.$k" "SKIPPED_NOW" skip "本次该项未测（skip）→ 不参与回归判定"; gated=$((gated+1))
    elif [ "$cur" != "$v" ]; then
      case "$k" in
        topo.*|http.health.play.*)
          record "drift.$k" "now=$cur base=$v" warn "拓扑/健康检查项：随 A3、A4 泳道启停变化，不作回归判据" ;;
        *)
          # 注意：http.playWorlds.* 是 L2 硬判据（地图元数据字节校验和），故意不豁免
          record "drift.$k" "now=$cur base=$v" fail "回归：与基线不一致"; drift=$((drift+1)) ;;
      esac
    fi
  done < <(cut -f1,2 "$BASELINE")
  DRIFT_COUNT=$drift
  GATED_COUNT=$gated
  return 0
}

write_baseline() {
  mkdir -p "$(dirname "$BASELINE")"
  cut -f1,2 "$RESULT_TSV" > "$BASELINE"
  contract_members "$DTS" | sort > "$MEMBERS_OUT"
  echo "baseline -> $BASELINE ($(grep -c . "$BASELINE") keys)" >&2
  echo "members  -> $MEMBERS_OUT ($(grep -c . "$MEMBERS_OUT") rows, sha256=$(sort "$MEMBERS_OUT" | sha_of))" >&2
}

# ================================================================ 主流程
DRIFT_COUNT=0; GATED_COUNT=0
check_contract
check_impl_coverage
check_module_resolution
check_map_inventory
check_http
check_topology
compare_baseline

if [ "$UPDATE" = 1 ]; then write_baseline; fi

# 三值判定：跑不到就绝不是绿灯。
#   FAIL    有真回归，或检查项被删
#   PARTIAL 没发现回归，但有 N 项因环境未测 → 不可当作通过合入
#   PASS    全部测到且与基线一致
VERDICT=PASS
if grep -q $'\tfail\t' "$RESULT_TSV" || [ "$DRIFT_COUNT" -ne 0 ]; then VERDICT=FAIL
elif [ "$GATED_COUNT" -ne 0 ] || [ -n "$GATED" ]; then VERDICT=PARTIAL
fi

if [ "$MODE" = json ]; then
  printf '{\n  "tool": "compat-check.sh",\n  "verdict": "%s",\n  "counts": {"pass": %d, "fail": %d, "skip": %d, "notMeasured": %d},\n  "checks": [\n' "$VERDICT" "$PASSES" "$FAILS" "$SKIPS" "$GATED_COUNT"
  # JSON 安全化：字段值里可能出现裸双引号/反斜杠（如 user:"0:0"）。
  # 这里直接删除这两类字符而不是转义 —— 键名与取值都是路径/哈希/计数，不含语义上需要的引号，
  # 删除后可保证输出一定是合法 JSON，且避免 awk 替换串里反斜杠转义的坑。
  awk -F'\t' '
    function esc(x) { gsub(/[\\"]/, "", x); gsub(/\t/, " ", x); gsub(/\r/, "", x); return x }
    { printf "%s    {\"key\":\"%s\",\"value\":\"%s\",\"status\":\"%s\",\"detail\":\"%s\"}", (NR>1?",\n":""), esc($1), esc($2), esc($3), esc($4) }
  ' "$RESULT_TSV"
  printf '\n  ]\n}\n'
else
  [ "$QUIET" = 1 ] || awk -F'\t' '{ printf "[%-4s] %-46s %s\n", toupper($3), $1, $2 }' "$RESULT_TSV"
  echo
  awk -F'\t' '$3=="fail"{ printf "FAIL  %s = %s | %s\n", $1, $2, $4 }' "$RESULT_TSV"
  awk -F'\t' '$3=="warn"{ printf "WARN  %s = %s | %s\n", $1, $2, $4 }' "$RESULT_TSV"
  echo
  echo "== $VERDICT  pass=$PASSES fail=$FAILS skip=$SKIPS notMeasured=$GATED_COUNT  baseline=$BASELINE =="
fi
case "$VERDICT" in PASS) exit 0 ;; PARTIAL) exit 2 ;; *) exit 1 ;; esac
