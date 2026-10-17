# W6 离线 / 自托管链核验（A1 泳道）

- 泳道：A1 离线/自托管链核验（纯静态 / CPU，禁 Docker，现网只读）
- 时间：2026-10-18
- 环境：bash 5.3.15(cygwin) ｜ node v24.18.0 ｜ cargo/rustc 1.97.1 ｜ 源码 `box3-local-engine` 分支 `slim/local-deploy`（工作区 20 项未提交）
- 纪律：本文每条主张都附**可复跑命令 + 原文输出**；跑不出来一律标 `UNVERIFIED`。仅改动 A1 所有权内文件，未提交、未联网、未碰现网。

---

## 0. 一句话结论

W6 的自托管放宽逻辑在**三层（Rust / Node / Shell）一致且经过实跑验证是对的**，但提交的 `release_channel.rs` **+261 行根本无法编译**（2 处 E0277），我已在所有权内修好并跑通该模块全部单测；`cargo check --offline` 因离线缓存缺 crate 无法覆盖整 crate，故整 crate 集成仍是 `UNVERIFIED`。G6 有 **8 条缺口**（2 条致命：编译、bootstrap↔install.sh opt-in 契约不一致），G7 的 **SBOM 与签名两条全仓 0 命中**，source commit 仅"部分"。

---

## 1. 核验清单（原文输出）

### 1.1 `bash -n` × 3（三个 shell 脚本）— PASS

```
$ cd box3-local-engine
$ bash -n distribution/linux-amd64/install.sh; echo $?   → 0
$ bash -n distribution/server/bootstrap.sh; echo $?       → 0
$ bash -n distribution/server/install.sh; echo $?         → 0
```
（`bash --version` = `GNU bash, version 5.3.15(1)-release (x86_64-pc-cygwin)`）

### 1.2 `node --check` × 2（两个 js）— PASS

```
$ node --check scripts/build-image-downloads.js; echo $?   → 0
$ node --check scripts/release-context.js; echo $?          → 0
```
（`node --version` = `v24.18.0`）

### 1.3 Rust：`cargo check --offline` — 失败于依赖（非代码）

```
$ cd apps/manager-core && timeout 90 cargo check --offline
error: no matching package named `tar` found
location searched: crates.io index
required by package `box-manager-core v2026.1.4 (...)`
note: offline mode (via `--offline`) can sometimes cause surprising resolution failures
exit=101
```
离线缓存有 504 个 crate，但 `manager-core/Cargo.toml` 依赖的 **`tar` / `urlencoding` / `zip` 三者均不在缓存内**（逐个 `ls ~/.cargo/registry/cache/*/<c>-*.crate` 为空）。按纪律**未做 cargo fetch / 未下载 crate**。因此整 crate 编译 = `UNVERIFIED`。

### 1.4 关键实跑：`release_channel.rs` 用 rustc 独立编译 — **发现致命编译错误并已修复**

`release_channel.rs` 只依赖 `std` + `super::*`（全文件 grep 无 serde/chrono/tar/zip 等外部引用，见证据），因此可脱离缺失依赖、用 `rustc` 独立对该模块做**完整类型/借用检查**。首跑原文：

```
$ rustc --edition 2021 --crate-type lib --emit=metadata rc.rs
error[E0277]: the `?` operator can only be used in a function that returns `Result` or `Option`
  --> rc.rs:93:42
44 | fn valid_mirror_base(base: &str) -> bool {
   | ---------------------------------------- this function should return `Result` or `Option` to accept `?`
93 |         let port: u32 = port.parse().ok()?;
   |                                          ^ cannot use the `?` operator in a function that returns `bool`
error[E0277]: ...  --> rc.rs:111:48 ...
111 |             let value: u32 = octet.parse().ok()?;
error: aborting due to 2 previous errors
```

**这是硬编译错误，不是依赖问题**：即便 `tar/urlencoding/zip` 齐全，`cargo check`/`cargo build` 也会因这两行 E0277 直接红。即"上一轮 +261 行从未编译过"得到实证。

修复后（`?` → `let Ok(..) = .. else { return false }`，语义不变：解析失败即视为非法 base）：

```
$ rustc --edition 2021 --crate-type lib --emit=metadata rc.rs            → lib_exit=0
$ rustc --edition 2021 --test rc.rs                                      → test_build_exit=0
$ ./rc_test --test-threads=1
running 4 tests
test tests::channels_cannot_download_each_others_installers ... ok
test tests::dev_installers_cannot_download_online_updates ... ok
test tests::self_hosted_base_is_inert_without_the_explicit_opt_in ... ok
test tests::staging_image_sources_are_pinned_without_fallback ... ok
test result: ok. 4 passed; 0 failed; ...
```
默认并行线程连跑 5 次：`run 1..5: PASS`（见 §5 关于 set_var 线程安全的注记）。**整 crate 集成（调用方是否编译、其余模块是否另有错）= UNVERIFIED**（依赖缺失）。

### 1.5 `build-image-downloads.test.js` — PASS（2/2）

```
$ node --test scripts/build-image-downloads.test.js
✔ splitting classic archives pins individual images and preserves their content
✔ splitting OCI archives pins individual images and preserves their content
ℹ tests 2  pass 2  fail 0
```

### 1.6 `release-context.test.js` — 1 FAIL（环境产物，非本人文件、非代码缺陷）

```
$ node --test scripts/release-context.test.js
... expected: /name = "box-manager-core"\nversion = "2026\.1\.5-staging"/, actual: "...box-manager-core"...version = "2026.1.5-staging"... (全部 \r\n)
at release-context.test.js:116
```
失败原因是 `Cargo.lock` 在 Windows 以 CRLF 检出，测试正则用 `\n` 断言版本同步行——属**换行符环境差异**，非逻辑缺陷，且 `release-context.test.js` / `Cargo.lock` 均不在 A1 所有权内，故只标注不修。LF 检出下该断言是否通过 = UNVERIFIED。

### 1.7 纯函数实跑：`validDownloadBase()` 策略矩阵 — 符合预期

```
$ node -e 'const {validDownloadBase}=require("./scripts/build-image-downloads.js"); ...'
undefined(default)                  => true
official                            => true
intranet-https w/o optin            => false
optin but NOT pinned                => false
optin + pinned https                => true
optin + pinned http-intranet        => true
optin + pinned http-ROUTABLE        => false      ← 明文公网即使钉死也拒
trailing-slash pinned match         => true
policy(no optin) = official bases only
policy(optin)    = official bases + 2 pinned self-hosted mirror(s)
```
`build-image-downloads.js:107 validDownloadBase()` **不再无条件拒绝自建域名**：仅当 `BOX3_ALLOW_CUSTOM_DOWNLOAD_BASE=1` **且** 该 base 精确出现在 `BOX3_RELEASE_CDN_URL_ALLOWLIST` 且通过 `validCustomDownloadBase()`（`:96`）时放行；明文 HTTP 仅限回环/RFC1918/link-local（`:101`）。默认官方源优先。

### 1.8 真实 Shell 校验器实跑（从文件抽取，非转写）— 与 JS/Rust 语义一致

抽取 `distribution/server/install.sh:95-134` 的 `valid_release_base()` 后喂入同批 URL：
```
https://assets.box3.fun/local-engine                ACCEPT
http://192.168.1.20:8080/local-engine               ACCEPT
https://mirror.intranet.example/box3/...            ACCEPT
http://203.0.113.9/local-engine                     REJECT   ← 明文公网
http://192.168.1.20:8080/local-engine/../etc        REJECT   ← 穿越
javascript:alert(1)                                 REJECT   ← 非法 scheme
http://010.0.0.1/local-engine                       REJECT   ← 八进制式补零 IP
https://203.0.113.9:8080/m                          ACCEPT   ← HTTPS 公网（钉死后才用）
```
三层（`release_channel.rs:44`、`build-image-downloads.js:96`、`install.sh:95`）接受/拒绝判定一致。

### 1.9 bootstrap↔install.sh 契约不一致（真实分支实跑，非推断）

抽取 `install.sh:136-164` 的 release-source 分支实跑：
```
-- CASE A: 仅设 BOX3_RELEASE_CDN_URL，ALLOWLIST 空（bootstrap 自身的放宽口径）--
BOX3_RELEASE_CDN_URL 未被 BOX3_RELEASE_CDN_URL_ALLOWLIST 明确允许，已停止。
caseA_exit=1
-- CASE B: URL + 精确 ALLOWLIST 钉死（install.sh 要求的口径）--
[BOX3] 使用自建发布源下载 Server Manager 镜像：http://192.168.1.20:8080/local-engine
release_source=[...] url=.../BOX3-Manager.tar.gz
caseB_exit=0
```
→ 见 G6.5。

### 1.10 linux 离线包 archive-list 解析分支实跑

抽取 `linux-amd64/install.sh:38-44` 于隔离临时目录跑（无 docker）：
```
CASE 默认, 无文件       → Missing box-local-engine-images-0.2.0-linux-amd64.tar.gz   exit=1
CASE 默认, 旧包在       → loop OK                                                     exit=0
CASE 覆盖 2 包, 缺 1     → Missing svc-b.tar.gz                                          exit=1
CASE 覆盖 2 包, 齐       → loop OK                                                     exit=0
```
→ 支持 `BOX3_IMAGE_ARCHIVES` 空格分隔多归档；默认名仍写死 0.2.0 见 G6.8。

### 1.11 `tauri.conf.json` JSON 合法性 — PASS
```
$ node -e 'require("./apps/deployment-manager/src-tauri/tauri.conf.json")' → parse OK
connect-src = ipc: http://ipc.localhost https://assets.box3.fun http://localhost:* http://127.0.0.1:*
```

---

## 2. G6 缺口表（断网安装→开服→进图，`BOX3_RELEASE_CDN_URL` 指内网）

| # | 缺口 | 证据 `path:line` | 严重度 | 状态 |
|---|---|---|---|---|
| G6.1 | `release_channel.rs` +261 行**根本编不过**：`valid_mirror_base` 返回 `bool` 却用 `?` | `release_channel.rs:93`、`:111`（E0277 原文见 §1.4） | **致命** | **已修**（所有权内），整 crate cargo build 仍 UNVERIFIED |
| G6.2 | `bootstrap.sh` 与 `server/install.sh` 的镜像 opt-in 口径**不一致**：前者只看 `BOX3_RELEASE_CDN_URL`(+明文开关)，后者**额外要求** `BOX3_RELEASE_CDN_URL_ALLOWLIST` 精确钉死，否则 `exit 1` | `bootstrap.sh:10`、`:65-78`、`:279`（无 ALLOWLIST 校验）↔ `server/install.sh:145-153`；实跑 §1.9 CASE A exit=1 | **高**（端到端 `curl bootstrap|bash` 指内网会在内层 install.sh 挂） | 未改（跨两文件的策略选择，见决策 D1） |
| G6.3 | `server-manager-rust` 更新链**完全不认自建镜像**：`release_base()` 恒返回硬编码 CDN，被用于①注入给更新器容器的 `BOX3_RELEASE_CDN_URL`②拉 `latest.json/latest-server.json` | `release_channel.rs:151-157`（`release_base` 只 PRODUCTION/STAGING）；`server-manager-rust/src/platform/configuration.rs:535`；`server-manager-rust/src/http/commands.rs:473,478` | 高 | 他人文件，仅标注 |
| G6.4 | 桌面管理器前端**写死 CDN base + WebView fetch**，无镜像机制 | `apps/deployment-manager/src/utils/releases.js:28`（`https://assets.box3.fun/...`）；`.../src/infrastructure/releases.js:7`（`await fetch(.../latest.json)`，受 CSP 约束） | 中 | 他人文件，仅标注 |
| G6.5 | Tauri **CSP `connect-src` 只放行 loopback，不放行内网镜像主机** | `tauri.conf.json:26`：`...assets.box3.fun http://localhost:* http://127.0.0.1:*`（无 `https://mirror.intranet…`/`http://192.168…`） | 中（若 WebView 直连非回环镜像则被拦；后端 reqwest 不受 CSP 约束） | 本人文件；缺 host 无法硬编码，需配置机制，见决策 D2 |
| G6.6 | `server/install.sh` 下载 URL **默认仍写死** `assets.box3.fun` | `server/install.sh:161`（默认）→ 仅 opt-in+pin 时被 `:162-164` 覆盖 | 低（内网+钉死可覆盖；纯离线须预置归档走 local 模式 `:182-184`） | 已具备覆盖路径 |
| G6.7 | `latest.txt` 缺失行为：离线须自设版本，否则拉 `latest.txt` 失败即终止 | `bootstrap.sh:275-289`（`BOX3_VERSION` 非 latest 跳过网络 `:276`；否则 `curl latest.txt`，失败 `fail` `:283`） | 低（fail-loud，可接受，但属 G6 checklist 项） | 行为已明确 |
| G6.8 | `linux-amd64/install.sh` 默认归档名**写死 0.2.0 单体包**，与 2026.1.4 逐服务归档产物不匹配 | `linux-amd64/install.sh:38`（默认 `box-local-engine-images-0.2.0-linux-amd64.tar.gz`），实跑 §1.10 CASE1 缺文件即 exit 1 | 低（注释 `:28-37` 声明为 legacy 兼容，需显式 `BOX3_IMAGE_ARCHIVES`+重算 SHA256SUMS） | 保留（有意 legacy） |

**离线包模式下镜像归档 sha256 校验：存在**（G7.1/G7.2）——`server/install.sh:169,174-180,205-214` 内联校 sha+size；`server/verify.sh:6` / `linux-amd64/verify.sh:8` = `sha256sum -c SHA256SUMS`；`scripts/verify-desktop-offline-package.js:49-56` 解析并校验 SHA256SUMS；catalog 逐镜像 `sha256`+`size` 由 `build-image-downloads.js:157-159` 强制。

---

## 3. G7 缺口表（每归档带 sha256 + size + 源提交 + SBOM + 签名）

| 要素 | 状态 | 证据 `path:line` |
|---|---|---|
| sha256 | **具备（已验）** | `split-image-archive.py:126`（`info['sha256']`）；归档名嵌 sha `:129`；`build-image-downloads.js:157` catalog 校验 64hex；`server/install.sh:169,176,189,206` 下载后复算；`verify.sh` `sha256sum -c` |
| size | **具备（已验）** | `split-image-archive.py:127`（`info['size']`）；`build-image-downloads.js:158-159` `Number.isSafeInteger && >0`；`server/install.sh:171,210` `wc -c == expected_size` |
| digest 钉死 | **具备** | `build-image-downloads.js:144-151` 逐镜像 `sha256:<64hex>` imageId/imageIds 校验；`configuration.rs:109` 经 `image_download_url` 消费（镜像感知） |
| 源提交（source commit） | **部分** | `split-image-archive.py:69` 每镜像记 `sourceRevision`=OCI `org.opencontainers.image.revision`，**缺省 `'unknown'`**；`release-context.js:61,67` 仅 staging 路径嵌 40-hex `GITHUB_SHA`。**缺口**：`build-image-downloads.js:125-166 validateCatalog` 不校验/不要求 `sourceRevision`，production 归档无提交绑定，允许 `'unknown'` |
| SBOM | **缺失（G7 未达）** | 全仓 `scripts/.github/apps/common` grep `sbom\|syft\|cyclonedx\|spdx` **0 命中**（§本文 1.8 grep，实跑 `No matches found`） |
| 签名 / 真实性 | **缺失（G7 未达）** | grep `cosign\|sigstore\|minisign\|gpg\|signature\|attest\|in-toto` **0 命中**；`server/verify.sh:5-9` 仅 `sha256sum -c`——**校验完整性而非真实性**，SHA256SUMS 本身未签名，镜像主机被控者可重算 SHA256SUMS 悄悄替换归档 |
| provenance/attestation | **缺失** | 无 workflow 步骤产出（`.github/workflows`: package-server/player-launcher-release/release-branch-created/release/verify.yml，均无 attestation） |

**G7 计数**：sha256 ✅、size ✅、digest ✅、source commit 🟡部分、SBOM ❌、签名 ❌、attestation ❌。

---

## 4. 已改动内容与理由（仅限 A1 所有权文件）

- `apps/manager-core/src/release_channel.rs`
  - **改动**：修复 2 处 E0277。
    - `:93` `let port: u32 = port.parse().ok()?;` → `let Ok(port) = port.parse::<u32>() else { return false; };`
    - `:111` `let value: u32 = octet.parse().ok()?;` → `let Ok(value) = octet.parse::<u32>() else { return false; };`
  - **理由**：原提交在返回 `bool` 的 `valid_mirror_base` 里用 `?`，属硬编译错误（§1.4 实证）；`cargo build` 必红，G6 一切无从谈起。改后语义完全不变（解析失败=非法 base=返回 false），且**独立 rustc 编译 + 4/4 单测通过**验证行为等价（含端口 `99999`/补零 IP `010.` 的拒绝用例）。
  - **公共 API 签名未动**：`image_download_url`/`valid_installer_url`/`release_base` 参数与返回不变，`self_hosted_base` 为新增 `pub`。全仓调用方（`deployment-manager/src-tauri/src/image_source.rs:3`、`updates.rs:4`、`server-manager-rust/.../configuration.rs:109` 等）不会因签名变化而破坏编译。

**未改动**：`bootstrap.sh`、`distribution/server/install.sh`、`distribution/linux-amd64/install.sh`、`build-image-downloads.js`、`release-context.js`、`tauri.conf.json` 经核验逻辑正确，保持原样；G6.2/G6.5 的跨文件策略改动留待用户决策（见 §6），不擅自统一。他人的 `server-manager-rust` / `deployment-manager/src` 文件（G6.3/G6.4）**只标注不修**。

---

## 5. UNVERIFIED 项（诚实清单）

1. **整 crate `cargo check` / `cargo test`（manager-core 及下游 deployment-manager、server-manager-rust）**：离线缓存缺 `tar`/`urlencoding`/`zip`，无法运行。我的 `rustc` 检查**只覆盖 `release_channel.rs` 单模块**（它 std-only，可独立全量类型检查），**不代表整 crate 无其他编译错**、不代表调用方集成通过。按纪律未 `cargo fetch`。
2. **G6 端到端实跑**（真断网环境安装→开服→进图、`BOX3_RELEASE_CDN_URL` 指内网）：未做。本泳道禁 Docker、现网只读；所有 G6 结论均为**静态/分支级**证据。
3. **G7 产出物实跑**（生成带 SBOM/签名的归档并验证）：无法做——仓库根本不存在 SBOM/签名环节可验。
4. **`release-context.test.js` 的 LF 通过性**：本机 CRLF 检出致版本同步断言失败（环境产物），LF 下是否绿 = 未验。
5. **set_var 线程安全**：新单测 `self_hosted_base_is_inert…` 进程内 `set_var/remove_var` 全局 env；`cargo test` 默认并行。本模块独立跑并行连测 5 次均绿（§1.4），但 `std::env::set_var` 跨线程在 Rust 语义上属 unsound（edition 2024 起需 `unsafe`），整 crate 并行跑时**潜在偶发竞态 = UNVERIFIED**。
6. **G6.5 CSP 是否真的拦截**：取决于桌面下载走 WebView 还是后端 reqwest——后端不受 CSP 约束，WebView 受；未实跑桌面构建，标 UNVERIFIED。

---

## 6. 需用户决策项

- **D1（G6.2，opt-in 契约统一）**：`bootstrap.sh` 现仅凭 `BOX3_RELEASE_CDN_URL` 就配置镜像（`:65-78`），而它调用的内层 `server/install.sh` 还要求 `BOX3_RELEASE_CDN_URL_ALLOWLIST` 精确钉死否则 `exit 1`。两条路二选一：①给 bootstrap 也加 ALLOWLIST 要求（更安全、一致）②放宽 install.sh 到与 bootstrap 同级。二者是**安全 vs 易用**取舍，且都在我所有权内但属策略变更，未擅动。当前最小可用文档口径：operator 必须**同时**导出 `BOX3_RELEASE_CDN_URL` 与 `BOX3_RELEASE_CDN_URL_ALLOWLIST`（后者含前者）。
- **D2（G6.3/G6.5，桌面 + server-manager 更新链的镜像支持）**：`release_base()` 返回 `&'static str`，无法返回运行期内网镜像串；要让 `latest.json` 更新清单与桌面管理器认内网源，须改 `server-manager-rust`（非我所有权）、`deployment-manager/src/utils/releases.js`（非我所有权）及 CSP 主机放行（我所有权）。是否纳入本轮范围？
- **D3（G7，供应链）**：SBOM + 签名/provenance 全仓 0，工作量大且跨 `.github/workflows`（A2/其他泳道所有权）。是否排期？最低门槛建议：先对 `SHA256SUMS` 附 cosign/minisign 签名（把"完整性"升级为"真实性"）。
- **D4（提交/落盘）**：本轮我修了 `release_channel.rs`（编译级致命错）但**未 commit**（纪律）。20 项未提交改动 + 本修复有丢失风险，是否 checkpoint commit（不 push）？
