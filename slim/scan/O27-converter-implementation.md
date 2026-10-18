# O27 · 转换器语义层交付（H2b 泳道，主控收口）

生成：2026-10-18 16:5x ｜ H2b agent 在 150 轮上限处被杀（语义层代码已完，文档未写），本文由主控按**亲自复跑**的结果收口。
仓：`box3-map-converter/` → 已 `git init` 并推送 `https://github.com/natsume-stack/box3-map-converter.git` `master = 6fd74d3`。

## 1. 一句话结论

容器层 + **语义层都已落盘并过真数据**：`node --test test/*.test.js` = **48 tests / 48 pass / 0 fail**（主控亲跑，非引用）。
`blob 复用` 路线作废已被实测坐实，转换器现在**自产 canonical 字节**，并且产出的 CID 能复现引擎自己写在箱内的名字。

## 2. 主控亲跑的三条闸（原文数字）

```
cd box3-map-converter && node --test test/*.test.js
  ℹ tests 48  ℹ pass 48  ℹ fail 0        # 收口前是 48/46/2，两处红见 §4
cd box3-local-engine && node --test tools/box3-map-mcp/test/*.test.js
  ℹ tests 178 ℹ pass 178 ℹ fail 0
cd box3-local-engine && node scripts/check-standalone.js      → EXIT=0（35 local modules, 377 bundled blobs）
wsl … bash box3-re/tools/compat-check.sh --quiet               → == PASS  pass=54 fail=0 skip=0 notMeasured=0 ==
```

## 3. 语义层两条承重断言（都是真样本，不是合成数据）

### 3.1 canonical 序列化（`src/format/canonical.js`，11 条测试）

- `stableStringify`：键按 **UTF-16 码元升序**、丢弃全部空白；非标值（`undefined`/`NaN`/负零/嵌套数组）显式处理。
- `minifyJson`：**保留 `JSON.parse` 会毁掉的键序与数字字面量** —— 纯数字 id 键经 parse→stringify 会被提前，所以"字节一致"只能对**原文字节**断言。这条口径由专门用例钉死。
- `parseBlobName`：覆盖实测到的**三种** blob 命名形态；`assertSelfReferential` 做 CIDv0 自指校验（blob 名必须等于其字节重新哈希的结果）。
- **真数据证据**（测试名即结论，主控跑过）：
  - `REAL flat dump: every sidecar JSON reproduces the CID the engine wrote in block.json`
  - `REAL flat dump: the root object hashes to the [Blank Map]<CID> directory name`
  - `REAL archive: a map root and all 15 referenced children are byte-identical under stableStringify`
  - `REAL archive: blob names self-refer under both digest forms`

### 3.2 体素（`src/adapters/voxels.js`，12 条测试）

`voxel-sparse.gz`（35,561 B → 190,672 B JSON 文本）→ `voxels{chunks[64]}`。合并顺序**不是自创**，逐字移植：
`services/game-server/src/voxel/box-encode.ts`（`signEncode`/`interleave3`/贪心极大长方体）、
`internals/schema/voxel/box-decode.ts`（`deinterleave3`）、
`services/game-server/src/voxel/voxel-server.ts:67-84`（`saveVoxelPreloadData()` 的 chunk 迭代序）。

- 承重证据：`REAL flat dump: voxel-sparse.gz rebuilds the exact voxels blob the engine referenced`、
  `REAL archive: decoding a voxels node and re-encoding reproduces all 64 chunk CIDs`、
  `the whole 128^3 grid encodes 64 chunks in z-y-x order, x fastest`、
  `boxCompress of an empty chunk is exactly the two zero bytes the archive stores`。
- 守卫：非平凡 `origin/dir`、外来 `stride`、缺 `indices` 一律**拒绝而不是猜**。

## 4. 主控收口时修的三处（原文状态 → 处置）

| 现场 | 判定 | 处置 |
|---|---|---|
| `test/voxels.test.js:25` 有游离 `-`（`-  blitBoxesToChunk,`），整文件 `SyntaxError` 直接载不进 | H2b 被杀时的半截导入块 | 修语法，并补回被吞掉的 `CHUNK_MASK` 导入 |
| `signEncode(-16)` 断言 `31`，实到 `32` | **不是移植缺陷**：引擎 `box-encode.ts:13-19` 自身 `x & CHUNK_MASK` 把 delta 折成 mod 32，`y > 16` 分支使 −16 与 +16 撞成同一码字 ⇒ −16 本就不可表示 | 断言改成引擎真值（`signEncode(-16) === 32 === signEncode(16)`），往返用例的取样从 `±16` 收窄到 `±15`，注释写明这是引擎行为、照抄不修 |
| `packCell(4095, 3)` 断言 `0x3fff \| (3<<14)`，实到 `0xCFFF` | 测试自变量笔误（把 12 位的 4095 当 14 位满量程写） | 改为 `packCell(4095,3)=0xcfff` + `packCell(0x3fff,3)=0xffff` 两条钉住 16 位布局；并注明 `VOXEL_TYPE_MASK=0x3fff` 的**引擎出处仍未定位**（不在 `box-encode.ts`） |

`UNVERIFIED`（H2b 被杀，未来得及做）：`VOXEL_TYPE_MASK` 的引擎权威出处；生成 `.boxproject` 被**真引擎导入**接受（本轮只做到箱内 CID 引用闭合 + 逐 chunk 复现）；`permissionHash`/`extraProjectHash` 全链闭合对真图跑通。

## 5. 体积与可复现性

`box3-map-converter` 整树 **634,219 B**；`fixtures/semantic/` 46 个文件 473 K（含真箱 blob 抽样与 `blank-map.zip`）。
新增 `.gitattributes`：`* text=auto eol=lf`，但 **fixtures 全部 `-text`/binary** —— 夹具是按引擎写出的原始字节比对的，git 一旦规范化换行就会让测试在别人的机器上假红。

## 6. 这条泳道解掉的是什么

`O22` 曾主张"zip 的 JSON 与箱内 blob 字节全等、可复用 13 项"，被主控复核否证（命中 1/10，唯一命中是 2 B 退化项；zip 根 CID 在箱内不存在）。**现在不需要复用了**：自产 canonical 字节能让同一内容哈希出同一个 CID，因此 `permissionHash` 一类引用不会因为"内容相同、CID 不同"而失配 —— 这是转换器能不能进真引擎的前提。
