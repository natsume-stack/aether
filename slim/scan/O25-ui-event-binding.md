# O25 · UI 节点 ↔ 脚本事件绑定的写入校验与一致性门（泳道 C）

日期：2026-10-18 · 泳道：C（轻量引擎 / BOX3 MCP）
依据：`box3-re/plan/N7-ai-adaptation-decisions.md` 决策 2 + 验收口径 C 行
交付：`tools/box3-map-mcp/src/ui-binding.js`、`tools/box3-map-mcp/test/ui-binding.test.js`（**只新建这两个文件，未编辑任何既有文件**）

---

## 0. 结论先说

**绑定关系在现有 schema 里是"表达得出来"的，但表达位置不在 UI 树里，而在客户端脚本正文里。**

一句话：控件靠 **name**（不是 id）被脚本寻址，回调靠 `节点.events.on/once/add('<UiEvent>', fn)` 挂在**脚本正文**上；`ui-rda` 持久化 schema 里没有任何能存绑定的字段。

所以本泳道的"一致性门"= **脚本正文 × uiTree 的静态交叉校验**，而不是往 schema 里塞一个 bindings 字段。这样才没有违反决策 2 的红线（不改 UI 数据形状、不新造事件模型）。

同时要点明一个**需要主控决策**的边界（见 §5）：如果产品要的是"编辑器里可视化拖绑、绑定随 UI 树持久化、能被引擎侧校验"，那**现有 schema 表达不出来**，必须扩 `ui-rda`（additive），那是引擎侧决策，不在本泳道授权范围内。

---

## 1. 源码证据（绑定到底怎么表达的）

### 1.1 事件名：五个，且只有五个

`packages/script-api/src/client/modules/ui.ts:4-28`

```ts
export interface UiEvent { target: UiNode }
export interface UiInputEvent { target: UiInput }
export interface UiImageEvent { target: UiImage }

export type UiNodeEvents = {
  pointerdown: UiEvent;
  pointerup: UiEvent;
};

export type UiInputEvents = UiNodeEvents & {
  focus: UiInputEvent;
  blur: UiInputEvent;
};

export type UiImageEvents = UiNodeEvents & {
  load: UiImageEvent;
};
```

⇒ 合法事件名集合 = `pointerdown / pointerup / focus / blur / load`；
其中 `focus / blur` 只属于 `UiInput`，`load` 只属于 `UiImage`（`ui.ts:118` `UiInput extends BaseUiText`、`ui.ts:138` `UiImage extends UiRenderable`）。

### 1.2 回调挂在哪个字段：`events`，API 是 EventEmitter

`packages/script-api/src/client/modules/ui.ts:45`

```ts
  /** 管理节点相关的事件 */
  events: EventEmitter<UiNodeEvents>;
```

`packages/script-api/src/client/modules/events.ts:10-63`（同类同目录还有 `input.ts`，注意：**`events.ts` / `input.ts` 在 `packages/script-api/src/client/modules/` 下，不在 `internals/schema/project/ui-rda/` 下** —— 任务书里"同目录还有 events.ts、input.ts"的表述不准确，已按实测更正）

```ts
  on<K extends keyof EventMap>(type: K, listener: (event: EventMap[K]) => void): void;
  once<K extends keyof EventMap>(...)     // :20
  remove<K extends keyof EventMap>(...)   // :30
  removeAll<K extends keyof EventMap>(...)  // :40
  add<K extends keyof EventMap>(...)      // :50  —— on 的别名
  off<K extends keyof EventMap>(...)      // :60  —— remove 的别名
```

⇒ `add` 与 `on` 等价、`off/remove/removeAll` 是解绑。门把 `on/once/add` 当"注册"，把 `remove/off/removeAll` 排除出重复判定。

### 1.3 控件如何被脚本引用：**按 name**，不是 id

`packages/script-api/src/client/modules/ui.ts:41`

```ts
  findChildByName: (name: string) => UiNode | undefined;
```

官方用法示例（同一份 API 文档里写死的惯用法）：
`packages/script-api/src/client/modules/world.ts:15-19`

```ts
   * const renderingBtn = ui.findChildByName('rendering3d');
   * renderingBtn.events.on('pointerdown', () => {
   *    console.info('Rendering switch!');
   *    world.rendering3d = !world.rendering3d;
   * })
```

⇒ **`findChildByName` 只声明在 `UiNode` 上**，所以脚本里任何 `X.findChildByName('lit')` 都必然是 UI 节点寻址；id 是引擎生成的数字串（`src/tools/ui.js:324` 注释"id 是引擎生成的数字串"），**不参与脚本侧寻址**。

真实数据核对（生产图 `cloud-4e84ee7ef626058f`，客户端入口脚本 blob `QmVHQfvSjhY6dQdn31xXpou24BXXRrJHcHgsG6j8hmymYd`，6153 字节）：

```
  5:const bagButton = ui.findChildByName('bagButton');
 41:const scrollBox = ui.findChildByName('scrollBox');
 42:const msgContent = scrollBox.findChildByName('msgContent');
 83:inputBox.events.add('blur', () => {
129:    let quickItem_ = quickItem.clone()
133:    quickItem_.findChildByName('quickNum').pointerEventBehavior = PointerEventBehavior.BLOCK_PASS_THROUGH
134:    quickItem_.findChildByName('quickNum').events.on('pointerdown', () => {
```

三种形态全都在真实图里出现：根寻址（`ui.findChildByName`）、子树寻址（`scrollBox.findChildByName`）、clone 后再寻址（`quickItem_.findChildByName`）。

### 1.4 `PointerEventBehavior` 的取值语义：**运行时赋值，schema 明确不收**

`internals/schema/project/ui-rda/defs.ts:812-835`

```ts
/**
 * 指针事件行为
 * 实现packages/script-api/src/client/modules/ui.ts的枚举
 *
 * TODO 暂时不放入UITreeNode中，目前并未提供相关的编辑项
 */
export enum PointerEventBehavior {
  DISABLE_AND_BLOCK_PASS_THROUGH = 0,  // 不响应，且不允许后方元素响应
  DISABLE = 1,                         // 不响应
  BLOCK_PASS_THROUGH = 2,              // 不允许后方元素响应
  ENABLE = 3,                          // 正常响应
}
```

运行时侧 `packages/script-api/src/client/modules/ui.ts:65`（`UiRenderable.pointerEventBehavior: PointerEventBehavior`）与 `:194-211`（同一枚举）。

⇒ 取值语义只有 4 个成员 / 0..3；**`defs.ts:816` 的 TODO 就是"这个字段没进 UITreeNode、编辑器没有编辑项"的直接证据**。真实图也是在脚本里赋值（133 行），不是在 UI 数据里。

### 1.5 UI 树里**没有**任何能存绑定的字段（负向取证）

对声明层做穷举检索：

```
Grep(pattern="binding|event|scriptEntry|handler", path="internals/schema/project", -i)
→ internals/schema/project/ui-rda/defs.ts:818: export enum PointerEventBehavior
```

全项目 schema 只有 **1** 处命中，而它恰好就是 §1.4 那个"暂不放入 UITreeNode"的枚举。

UI 树的真实形状（`defs.ts:768-792`、`defs.ts:837-867`）里，节点 `value` 只有 `screen` / `element` 判别位，element 只有 `box/image/text/scrollBox/input` 五个渲染分支：

```ts
export const UIElementSpec = { box: UIBoxRDA, image: UIImageRDA, text: UITextRDA, scrollBox: UIScrollBoxRDA, input: UIInputRDA };
```

生产树里一个真实 element 节点（id `3079413`，name `R`）的全部键：

```json
{"childrenIds":[],"id":"3079413","name":"R","parentId":"772155591","type":2,
 "value":{"data":{"data":{"anchor":[0.5,0],"autoResize":0, … ,"visible":true,"zIndex":1},"type":"text"},"type":"element"}}
```

⇒ 27 个属性全是渲染属性，**零个事件/回调字段**。真实地图 61 个节点的属性并集里也没有（`box3-re/tmp/c-real-ui-summary.txt` 的 `undeclared {}` 与 `sampleProps`）。

### 1.6 脚本资产如何被寻址

- HTTP 面：`side`(client|server) + `entry`，`entry` 形态 `^[A-Za-z0-9._-]{1,160}$` 且不含 `..`（`tools/box3-map-mcp/src/script-write.js:28,42-58`）；map-local 保留入口 `index.js` / `clientIndex.js`（`:30`）。
- 类型位：1=server / 7=client（`script-write.js` 引用 `project-manager.js:2165-2171`，见 `src/errors.js:120` 的 `LOCAL_SCRIPT_SIDE_MISMATCH`）。
- 正文内部：相对 import 说明符。真实图入口脚本第 1 行就是 `import { ColorList } from "./cilentConfig.js";`（**注意原文拼写是 cilent**，照抄不改），对应 blob `pTtGEcq3eflHGa3p6XCbcwSJy29GnXUyjtkRCrVORp0`（404 字节，确实存在）。
- **UI 面只在 client 侧存在**：`packages/script-api/src/server/modules/` 下 14 个模块（anticheat/entity/error/events/http/math/moderation/motion/navigator/player/rtc/storage/world）里 **没有任何 `findChildByName`**（`grep -rln findChildByName server/` 空结果）。⇒ 服务端脚本写 UI 绑定必错，成为 R10。

---

## 2. 校验规则清单（10 条，每条都有正例 + 反例）

错误契约与 A 泳道 `src/errors.js` 的 `{code, retryable, hint}` **同形状**，但**没有 import 它**（零依赖纯函数，接线由主控事后做）。每条问题都带这三个字段，外加 `severity / rule / message / path / subject` 等上下文。

`retryable` 语义沿用 `src/errors.js:13`："re-issue THIS call after you have done the hint"。⇒ 调用方改自己的输入就能重跑的为 `true`；只有输入不成形（R1）为 `false`，因为原样重跑永远不会好。

| 规则 | 判定 | 错误码 | severity | 正例（绿） | 反例（红） |
|---|---|---|---|---|---|
| R1 | `uiTree` / `scripts` / `bindings` 类型不对 | `UI_BINDING_INPUT_INVALID` | error（retryable **false**） | `{uiTree,scripts}` 齐全 | `{}`；`scripts:'index.js'`；`bindings:{...}` |
| R2 | 悬空控件：脚本引用的 name、或绑定提案的 nodeId/name 不在树内；子树寻址越界 | `UI_TREE_REF_UNRESOLVED` | error | 13 处真实引用全部命中 | `findChildByName('ghostButton')`；`panel.findChildByName('elsewhere')`；`nodeId:'999999'` |
| R3 | 事件名不在 `UiEvent` 五个名内（**只对可证明是 UI 发射器的接收者判定**） | `UI_EVENT_NAME_INVALID` | error | 五个名全用 `on/once/add` 注册 | `b.events.on('click')`；`b.events.on("tap")`（双引号） |
| R4 | 事件名合法但节点类型不支持（focus/blur 需 `input`，load 需 `image`） | `UI_EVENT_KIND_MISMATCH` | **warning** | `inputBox`+`focus`、`avatar`+`load` | `score`(text)+`focus`；`bagButton`(box)+`load` |
| R5 | 指向不存在的脚本：import 目标不在清单；绑定声明的 `side+entry` 不存在 | `UI_SCRIPT_NOT_FOUND` | error（`scriptsAreComplete:false` 降级 warning） | `./cilentConfig.js` 命中清单 | `./nope.js`；`script:{side:'server',entry:'index.js'}` |
| R6 | 重复绑定：同脚本对同控件同事件注册两次；绑定提案重复同一 `(控件,事件)` | `UI_BINDING_DUPLICATE` | error | 同控件不同事件 / 不同控件同事件 | `on('pointerdown')` 两次；`on` + `add` 同事件 |
| R7 | `PointerEventBehavior` 成员名不存在，或数字越出 0..3 | `UI_POINTER_EVENT_BEHAVIOR_INVALID` | error | `BLOCK_PASS_THROUGH` / `ENABLE` / `= 2` | `PointerEventBehavior.HOVER`；`= 4`；`= -1` |
| R8 | 控件重名 → 按名寻址无法确定命中节点 | `UI_NODE_NAME_AMBIGUOUS` | error | 真实 61 节点树无重名 | 两个节点都叫 `dup` |
| R9 | 孤儿节点：`parentId` 指向树内不存在的节点 | `UI_ORPHAN_NODE` | error | 真实树父链完整（0 孤儿） | `parentId:'NO_SUCH_PARENT'` |
| R10 | 服务端脚本里出现 UI 绑定调用 | `UI_BINDING_SIDE_INVALID` | error | 同一段代码放 client | 同一段代码放 server |

### 2.1 最关键的防误报设计（R3 的接收者判定）

真实生产脚本第 119/125 行有：

```js
remoteChannel.events.on('client', event => {// 客户端监听
```

`client` **不是** `UiEvent`。如果门把所有 `.events.on(...)` 都当 UI 绑定，就会对着一张完全正常的旧图报假案（这恰好是决策 2 最怕的"AI 被误红逼着去改数据形状"）。

⇒ 门的判定是：接收者是 `ui`、或是静态可证为 UI 节点的变量（`ui.findChildByName` / `X.findChildByName` 赋值、`.clone()` 产物）、或是 `findChildByName(...).events.on(...)` 链式 —— 才当 UI 绑定；**未知/非 UI 接收者一律放过，而不是猜**。测试把这条钉死：

- `真实地图整体通过` → `problems` 为空数组；
- `R3 关键防误报` → `scan.registrations.filter(r=>r.event==='client')[0].isUi === false`。

### 2.2 判定边界的诚实说明（门的漏报面）

正文扫描是**正则静态扫描，不是 AST 解析**。已知会漏：

- 通过扫描器无法归类的变量拿到节点（对象属性、函数返回值、解构赋值）→ 看不见；
- `findChildByName(<非字面量表达式>)` → 跳过；
- 子树断言只在接收者是静态可知的 UI 变量时才做，否则退化成全树名字命中（保守放过）。

⇒ 所以 `ok:true` 的含义是 **"我能看见的部分没有坏"**，绝不等于"这张图的绑定全对"。这条已经写进 `scanScriptBindings` 的文档注释，避免下游把它当完备证明。

---

## 3. 实测：反例真的变红 + 测试原文数字

命令（宿主 node v24.18.0；WSL 无 node；`node --test` 必须传 glob，传目录不行）：

```
cd D:/desktop/神奇代码岛/box3-local-engine/tools/box3-map-mcp
node --test test/ui-binding.test.js
```

本泳道原文输出：

```
ℹ tests 49
ℹ suites 0
ℹ pass 49
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 158.7189
```

（同一份用例在加行号准确性用例前的一轮是 48/48、409.4867 ms；上表是最终一轮原文。）

全量（含其他泳道并行交付）：

```
node --test "test/*.test.js"
ℹ tests 137
ℹ pass 135
ℹ fail 2
```

2 条失败**都不是本泳道的文件**，且都不是我造成的（详见 §6）。

反例变红的机器自证：`规则表：十条规则，每条都有对应反例真的变红` —— 它把 R2…R10 九条码混在一个坏输入里跑，逐条 `assert.ok(hit.has(rule.code))`；任何规则失效就 CI 红。`BINDING_RULES.length === 10` 也被断言，规则表本身不许偷偷增删。

真实地图上"规则确实咬住了真数据"的证据（不是空输入蒙绿）：

```
scanScriptBindings(真实脚本) →
  refs            = 13   （前四个：bagButton, cameraButton, sidebar, choosecase）
  UI registrations = 2   （blur@83, pointerdown@134）
  behaviors        = 1   （BLOCK_PASS_THROUGH@133）
  imports          = 1   （./cilentConfig.js@1）
validateUiBindings({真实树 61 节点, 真实脚本}) →
  ok:true  errors:0  warnings:0
  checked:{nodes:61,scripts:2,bindings:0,refs:13,registrations:2,behaviors:1,imports:1}
```

反例对照（同一张真图，只抽掉一个 `bagButton` 节点）→ `ok:false`，且恰好 1 条 `UI_TREE_REF_UNRESOLVED`。

---

## 4. "旧图逐字节不变"的实测

### 4.1 为什么不能用 Blank Map.zip 当 UI 回归样本

`C:\Users\Natsume\Downloads\Blank Map.zip`（225879 字节）解出来的 `[Blank Map]QmYpbdQEED1XbwkcMTkqHh4rjiY5c3oiV65QuenxRJt77u/` **根本没有 uiTree 文件**：目录里只有 `block.json / assets.json / scriptAssets.json / scripts/ / voxels / …`，`unzip -l | grep -i "ui|screen"` 零命中。空图没有 UI 树，拿它做"旧图 UI 读回不变"的回归没有意义。⇒ 改用仓库里已经解出来的**真实生产图 blob 链**。

### 4.2 真实样本与取证命令

工程根：`D:/desktop/神奇代码岛/box3-re/tmp/h1-bp/projects/cloud-4e84ee7ef626058f`
blob 链（只读）：`source/project-state.json` → `permissionHash` → `versionControl` → `branches[currentBranch].headHash` → `block.uiTree`

```
source/groupProjectMetaData.hashes.uiTree = QmeE9eD83rdVnKzFrkUEinvmBxfPnzP81Pf7uAUCJHFNhV
  磁盘字节      40073 B
  字符数        40003 （中文属性值 UTF-8 按 3 字节计，故字节数 ≠ 字符数）
  sha256        ec10a3bc74712b3536788e19b7be1d5eb545112ecc71e59785ce3b1c43892530
  节点数        61
  类型分布      text 35 / image 22 / input 1 / scrollBox 1 / screen 1 / root(undefined) 1
  重名节点      0
  父子链断裂    0
客户端脚本 blob QmVHQfvSjhY6dQdn31xXpou24BXXRrJHcHgsG6j8hmymYd  6153 B
```

复现命令：

```
cd D:/desktop/神奇代码岛/box3-re/tmp
node -e "…读 project-state.json→permissionHash→versionControl→headHash→block.uiTree，
        打印 Object.keys(uiTree).length / JSON.stringify(uiTree).length /
        Buffer.byteLength(raw,'utf8') / sha256 / 重名数 / 孤儿数"
```

### 4.3 门是只读的：三条断言

1. **深冻结不抛错**：把真实 61 节点树 `deepFreeze` 后跑校验。ESM 是严格模式，任何写入尝试都会 `TypeError`；实测不抛 ⇒ 门没有写字段、没有补默认值、没有排序键。
2. **输入前后逐字节相等**：`JSON.stringify(uiTree)` 跑前/跑后 `assert.equal`，且与深拷贝等价；`scripts[0].content` 同样比对。**坏输入（反例）也跑同样断言**，证明"报错"不会顺手"修数据"。
3. **确定性**：同一输入两次跑，`assert.deepEqual` 全等（问题集不含随机/时间成分）。

### 4.4 取证时撞到的一个坑（会误导"逐字节不变"的口径）

`JSON.parse(blobText)` 再 `JSON.stringify(它)` **不等于原文件字节**：第一个键从 `"100207687_132055051"` 变成 `"3079413"`。原因是 JS 对象把"像数组下标的键"（纯数字串）提前，与我的校验器无关，是语言语义。

⇒ 所以"旧图逐字节不变"只能对**原文字节**断言，不能对 `parse→stringify` 往返断言。测试里专门用一条用例（`已知陷阱（不是校验器造成的）`）把这个口径钉死，并断言真实 blob 名和字节数，防止后来者把这条误写成"序列化稳定"。

---

## 5. 需要主控决策的点（决策 2 里"停下"的那一半）

**现有 schema 表达不出"声明式绑定"**，证据链：`defs.ts:816` 的 `TODO 暂时不放入UITreeNode中，目前并未提供相关的编辑项` + §1.5 的穷举检索（全项目 schema 只有 `PointerEventBehavior` 一处事件相关符号，且不在树里）+ 真实节点的 27 个属性里 0 个回调位。

本泳道**没有**扩 schema（一个字段都没加，`packages/` / `internals/` 只读）。但这留下三个只能由主控拍的问题：

1. **要不要"绑定可被引擎持久化"？** 现在绑定只活在脚本正文里 ⇒ MCP 无法用 `uiNodeAdd` 建绑定，只能靠 `script_write` 写正文；门也只能在写正文前后跑。若产品要可视化绑定面板 / 绑定随 UI 树存盘 / 出厂 reader 侧强校验，就必须给 `ui-rda` 加 additive 字段（例如节点上挂 `bindings[]`），并让 `PointerEventBehavior` 真的进 `UITreeNode`（`:816` 的 TODO 就是这件事的立项入口）。**这是引擎侧 schema 变更 + compat-check 判定，超出 C 泳道授权。**
2. **门在哪个时点接线？** 建议：`script_write`/`script_patch` 的 `confirm:true` 之前，`typegate` 之后跑一次（拿到 uiTree + 全量脚本清单），把 `problems` 并进 A 泳道已有的 `unverified/failures` 语义：`severity:'error'` 拦写、`warning` 放行但回报。需要 uiTree 的读取通道（`uiTreeRead` 要活动运行时，或 `BOX_MAP_PROJECTS_ROOT` 走盘上 blob 链）。**接线由主控做，我没有碰 `src/tools/ui.js`、`src/tools.js`、`src/tools/index.js`、`src/errors.js`、`src/dod.js`。**
3. **重名控件要不要变成硬门？** 真实生产图是 0 重名，所以现在开 R8 不会打旧图；但**任何存量云图可能有重名**（我手上只有一张真实图）。是否让 R8=error 属产品取舍，先按 error 交付、可随时降级。

---

## 6. 负向结果（不许藏）

1. **`tools-wiring.test.js` 的 seam 断言与本泳道交付天然冲突（不是我越界）。**
   A 泳道在 `test/tools-wiring.test.js:280-281` 写死了：

   ```js
   assert.equal(fs.existsSync(path.join(srcDir, 'dod.js')), false, 'lane A 不得创建 src/dod.js')
   assert.equal(fs.existsSync(path.join(srcDir, 'ui-binding.js')), false, 'lane A 不得创建 src/ui-binding.js')
   ```

   这两条断言"别的泳道的文件不许存在"，而 C/E 的**任务就是创建这两个文件** ⇒ 一旦交付就必红。实测顺序证明失败先于我发生：报错信息是 `lane A 不得创建 src/dod.js`（第 280 行），`src/dod.js` 在本次会话开始时**就已经存在**（E 泳道产物），当时第 281 行还没执行到。
   同文件第 270-278 行那个循环（"lane A 的文件不许 `import` dod/ui-binding"）是**正确的那半**，实测通过：`grep -rn "ui-binding" src/`（排除我自己那份）零命中。
   ⇒ 建议主控把 280/281 改成只断言"lane A 自己的文件不 import 它们"（循环已覆盖），别断言文件不存在。**我没有编辑它**（边界禁止），只上报。

2. **`test/dod.test.js` 载入失败**（`SyntaxError: Unexpected token '&&'`）。E 泳道在我跑全量的中途落盘了半成品测试文件。与本泳道无关，但全量数字里它是红的，如实记。

3. **`compat-check.sh` 本次未跑**：它需要 WSL + docker/http 探针，而我**没有产生任何 schema / 数据形状变更**（新建两个纯函数文件，引擎侧只读），"只允许增长/超集"的判定没有被触发。真正需要它判的是 §5.1 那个"要不要加 `bindings` 字段"的决策 —— 那是主控决策后才要跑的门。**UNVERIFIED**（未实测，因为前提不成立）。

4. **门的漏报面**见 §2.2：正则扫描不是 AST，`ok:true` 只等于"可见部分没坏"。

---

## 7. UNVERIFIED 清单

- `uiNodeAdd` 的 `screen.layout` 形态在引擎侧的强校验（A 泳道 `src/tools/ui.js:120` 自己标了 advisory、未在本地验证）——本泳道不碰写路径，未验证。
- R4 的"类型不支持"是否有运行时豁免（例如 focus 在 scrollBox 上是否静默无害）：只依据 `ui.ts:21-28` 的类型层结论，没跑过引擎。故 R4 定级为 **warning**，不拦门。
- 除 `cloud-4e84ee7ef626058f` 之外的存量真实图是否 0 重名 / 0 孤儿：手上只有这一张，未普查。
- Blank Map.zip 的 UI 树：不存在该文件（§4.1），无从它取证的可能。

---

## 8. 交付物

| 文件 | 内容 |
|---|---|
| `tools/box3-map-mcp/src/ui-binding.js` | 零依赖纯函数门。export：`validateUiBindings`、`normalizeUiTree`、`scanScriptBindings`、`stripComments`、`UI_EVENT_NAMES`、`POINTER_EVENT_BEHAVIOR_MEMBERS`、`POINTER_EVENT_BEHAVIOR_VALUES`、`BINDING_RULES`。37100 字节，sha256 `63ac1e34a533293de93ef6bee7a3f49326ff55057b65f037dbef2e537036f2f1` |
| `tools/box3-map-mcp/test/ui-binding.test.js` | 49 条用例（十条规则各正例+反例，含真实树/真实脚本的内嵌字节回归）。87270 字节，sha256 `1b20c5c59ef11313eff2ed22e36837bd01cf48bb50a02448d76af2c6fde9157d` |
| `box3-re/scan/O25-ui-event-binding.md` | 本文 |

边界自查：`git status --porcelain tools/box3-map-mcp/src/ui-binding.js tools/box3-map-mcp/test/ui-binding.test.js` → 两个 `??`（新建）；`git diff --name-only` 里 `packages/`、`internals/` 零命中；未碰 docker、未碰现网容器、未 push、未写凭据。
