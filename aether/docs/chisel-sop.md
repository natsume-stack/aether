# AI 精细 VOXA 建模 SOP —— 打通"最后一里路"

> 2026-10-25 · 青冥问道 project-mvn0s7wz 实战沉淀
> 产物：`box3-re/_scratch/qingming/build/vox-sculpt.mjs` + `models-v2-defs.mjs` + `build-models-v2.mjs` + `replace-models-v2.mjs`

## 0. 一句话结论

AI 建模粗糙的根源不是管线，而是**内容**：旧管线把模型当"几个纯色长方体"拼装。
解法 = SDF 雕塑轮廓 + 材质色阶渐变 + 逐体素手绘上色 + 视觉评审闭环。

## 1. 定量差距（起床战争 154 模型 vs 旧 AI 5 模型）

| 指标 | 人做模型 | 旧 AI 模型 | 新管线 v2 |
|---|---|---|---|
| 调色板色数 | 20–256 | **5** | 29–42 |
| 实际用色 | 10–28 | 4–6 | 17–30 |
| 可见面片 rects | 80–2439 | 48–90 | 463–2558 |
| 贴图 texels | 1k–10k | 36–54 | 3078–10098 |
| 模型尺寸 | 16–112 | 10–14 | 22–50 |

**门禁（对标人做下限）**：palette≥28、usedColors≥12、rects≥160、texels≥1200。

## 2. 格式逆向（@box/voxa-project + @box/mesher）

- **model-data.bin** (v7) = `varint(7) + mudb diff(ModelDataV7{nodes, texture, meshes, animations})`
  - `texture.palette`: uint32[]，`RGB<<8 | emissive*255`；`data`: 每可见 texel 的调色板索引
  - `meshes`: 每体素组 6 面贪心矩形 `{vertices, sizes, uvs, uvFlags}`
  - **体素颜色 = VoxelView 里的调色板索引**（0=空，索引即 palette items 顺序，id 必须 1..N 连续）
- **project.bin** (v10) = VOXA 编辑器工程：nodes(ROOT/ROOT_BONE/ROOT_SKIN/Bone/SkinPart) + voxels(RLE) + palette(items {id,hsv,rgb,material.emissive}) + animations(keyframe offset {translation?,rotation?,scale?,alpha?})
- **model-meta.bin** = JSON `{version:7, bounds, dataHash, motionList, useCustomBounds, customBounds{size,offset}, renderBoxOffset}`
- blob 哈希 = **CIDv0**：`base58(0x12 0x20 + sha256(content))`（⚠ base58 生成器里 `text +=` 不是 `text =`）
- `.voxaproject` zip = manifest.json + project.bin + model-meta.bin + model-data.bin + preview.bin

## 3. 精细建模管线（vox-sculpt）

```
Palette.ramp(name, hex, {steps 6-10, vRange, hueShift, emissive})  → R(t) 取色函数
sd.*  : sphere/ell/roundBox/capsule/cylinderY/torusZ/torusY/lathe(车削)/polylineTube(贝塞尔管)/smoothUnion
Sculptor(nx,ny,nz):
  .fill(sdf, paint(x,y,z,{d}))   雕塑+逐体素上色
  .repaint(paint, mask) / .carve(sdf) / .mirrorX()
noise: hash3 / valueNoise3 / fbm3（确定性种子）
```

**手工感上色配方**：`ramp(高度比 t ± fbm 抖动)` 底暗顶亮 + 边缘高光 + 纹样遮罩（角向回纹/条带/镂空/刻字）+ 局部铜锈/苔藓低频噪声 + 发光芯（emissive ramp）。

**结构对齐人类习惯**：mesh 组只按动画骨骼拆分（静态细节合成一组），骨骼挂独立组做动画（ flap/float/bob/flicker/idle，支持 EASE_IN_OUT_SINE）。

## 4. 视觉评审闭环（关键！）

1. `renderSoftwarePreview`（等距体素软渲染）出 PNG
2. **视觉模型评分**（analyze_image）：轮廓成立性/部件可见性/颜色层次/结构缺陷 → 1-10 分
3. 按评语修 defs（rev1→rev2：丹炉双耳 torusZ 竖环+地火下移、鹤翼贴身放大+腿加长、碑穗正坐标、狮球贴爪、舟云嵌入）
4. 复审直到 ≥8 分

实测：丹炉 5→8.5、鹤 6.5→8、碑 7.5→8、狮 7→8.5、舟 7→8。

## 5. 原地替换导入 SOP（实体零改动）

实体引用 `mesh/<名>.vb` 按名绑定，所以**不要 importLocal（会加 "(2)" 后缀）**，用 update：

```
1. node build-models-v2.mjs        # 出 bundle + 校验 meta.dataHash == cid(data)
2. 4 件套上传 VOXA(3001) /api/local/blob
3. POST 10080 /api/project-models {action:'update', name, newName:name,
     modelFileHash:<meta>, previewHash:<preview>, projectFileHash:<project>}
   （误建的同名(2)用 action:'delete'+'purge' 清理）
4. POST 10080 /internal/save-local-project
5. WSL: 新 dataHash blob 落两处：
     projects/project-mvn0s7wz/source/blobs/  +  apps/local-engine/data/blobs/
   （从 172.27.64.1:3001/api/local/blobs/<hash> 取，VOXA 容器兜底只认容器内 VOXA）
6. runtime-blobs.json 的 hashes[] 追加 dataHash
7. docker exec box-local-engine-creator-1 … __local_runtime/destroy + start
8. 验证：GET http://127.0.0.1:<runtimePort>/engine/m/<dataHash> == 200
```

## 6. 游玩态验证（3127 编辑器）

- 创作权限：玩家门户注册 → player-service(3124) `POST /api/play-admin/owner-session`（Bearer `BOX_PLAY_ADMIN_TOKEN`，容器 env）→ PATCH `/api/play-admin/players/<subjectId>` `{creatorAccess:true, creatorPermissions:[projects.view|create|edit|delete|import|export, models.manage]}`（需回传 `box_local_admin_csrf` cookie 值到 `x-box-admin-csrf` 头）
- 从 `/projects` 进编辑器（**同名工程有两张卡，第一张是 -imported 暂存工程**，认准 URL `/e/project-mvn0s7wz`）
- 顶栏运行按钮在页面坐标约 **(1250,26)**（"运行中, 无法编辑地图"=成功）
- WASD 走近 `qm_传送_*` 蓝色光环 + E 交互 → 出现「已抵达·丹霞谷」+ 首次奖励文案 = `player.position.set` 传送链路 OK
- console 里唯一噪音是 cloudflareinsights CSP（外部统计，忽略）

## 7. 本轮验收状态

- ✅ 模型 404 根治：5 个旧 dataHash + 5 个新 v2 dataHash 全部双库就位，`/engine/m/` 全 200
- ✅ 5 模型精细重建并原地替换（预览评审 8–8.5/10，编辑器模型列表/游戏内渲染均确认）
- ✅ 传送实测成功（丹霞），回城阵可见；HUD/交互/存储正常
- ✅ 编辑器加载无模型 404 / 无 TypeError（历史"检测到脚本错误"为加载前旧通知，整轮运行未见复发）
- ⚠ project-state 元数据残留 5 个无害 "(2)" 死键（编辑器回收站 UI 可能显示空条目）
- ⏭ 未做：第三阶段内容（主大厅模型群/场景模型群/玩法深化/HUD 窄屏响应式）
