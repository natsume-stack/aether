# aether · 以太

> AI 大世界构建引擎 —— 让 AI 像人类制作人一样思考：这个游戏该包括什么、
> 空间怎么布局、什么风格、怎么设计才好玩、才震撼。
> 命名系：aether / muse / gaia / prism / chisel（同 feather · sol · terra 之风）

## 引擎命名

| 引擎 | 名称 | 目录 | 职责 |
|---|---|---|---|
| **项目总名** | **aether**（以太·界） | `/` | AI 建图系统的统称与集成管线 |
| 游戏设计大脑 | **muse**（缪斯） | `src/muse/` | 类型学知识库 + 空间规划 + fun 自评，产出 GDD（全链头部） |
| 地形引擎 | **gaia**（盖亚） | `src/gaia/` | 大尺度玩法驱动地形：大陆廓形/生物群系/河流/路网/散布，任意尺寸 |
| UI 引擎 | **prism**（棱镜） | `src/prism/` | 游戏风格 → UI 套系：5 主题 × 19 真组件 + 三分辨率布局求解 + 截图渲染 + 引擎桥 |
| VOXA 建模引擎 | **chisel**（凿） | `src/chisel/` | SDF 体素雕塑：色阶调色板/逐体素上色/自评修复循环 → VOXA v7/v10 |
| 共享层 | — | `src/shared/` | feather 兼容层（png/截图/设计系统工具） |

## 快速开始

```bash
# 游戏设计大脑：生成并校验 GDD（10 类型：像素战争/起床战争/竞技场/修仙RPG/生存建造/跑酷/塔防/大逃杀/夺旗/躲猫猫）
node src/muse/selftest/brain/run-selftest.mjs

# UI 引擎 prism：两主题 × 三分辨率 HUD 套件（Edge 截图渲染）
node src/prism/selftest/ui/run-selftest.mjs

# 全链路：GDD → UI（→ gaia/chisel 就绪后自动接入）
node examples/run-pipeline.mjs 像素战争 512 512
```

## 各引擎验收线

- **muse**：5 类型 GDD 全过 `gdd-validate`；fun 四维（clarity/pacing/balance/depth）≥70
- **prism**：0 重叠、0 越界（1366/989/390）；主题 token 一致率 ≥95%；像素套系视觉评审 9/10
- **gaia**：陆地占比 0.45–0.75、POI 连通率 100%、zone 平均坡度 ≤0.35、≥4 生物群系可见
- **chisel**：palette≥28 / usedColors≥12 / rects≥160 / texels≥1200；剪影单主体、悬浮簇=0、调色板熵 2.2–4.5

## 架构

```
muse.generateGDD(类型/尺寸/种子)
   └→ GDD/0.1（zones · poiGraph · terrain · ui.components · models · fun）
        ├→ gaia   : GDD.terrain + zones → TerrainPlan（高度场/生物群系/河流/路网/散布）→ 俯瞰渲染 → 执行器(可选)
        ├→ prism  : GDD.ui + artStyle → 主题套件 → 布局求解 → 截图渲染 / 引擎节点桥
        └→ chisel : GDD.models + artStyle → 雕塑程序 → critic/修复循环 → .voxaproject bundle
```

## 版史

- v0.1.0 · 2026-10-25 · muse + prism 完成自测；gaia/chisel v3 在途（chisel v2 核心已就位）
