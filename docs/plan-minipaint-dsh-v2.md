# miniPaint × DSH 下一版计划（v0.37 → v0.39）

> 目标一句话：把 miniPaint 从"能被 DSH 点几下"改造成**一份可被 Agent 精确编辑、可核对、可接管的设计文档**，
> 同时让 PSD 这条链路更真实（读得细、写得出来）、界面更像工作台、助手能自己做完更多可逆的事。

本计划建立在四个前提上，都不是口号：

1. **命令面就是能力面。** 现在白名单 19 条，缺的不是"更聪明的模型"，而是"没有 `layer.align` 这种动词"。
2. **不可核对的能力等于没有。** 每条新命令都要能被 `read_state` 读回来、被 `analyze` 量出来。
3. **权限放大必须可逆。** 助手能自主做的，只能是"撤销一步就干净"的属性编辑。
4. **不把 mock 当生产力。** 真重绘后端仍未接入；PSD 写入先只保证"我们自己的合成结果能分层存回"。

---

## 0. 这次要解决的四个问题（用户原话拆解）

| 用户要求 | 具体缺口 | 落在哪一阶段 |
|---|---|---|
| miniPaint 更适合 DSH 操作 | 19 条命令里没有对齐/复制/编组/合并/效果栈/蒙版反转；写一次要读一次，缺"一次读多处改" | Phase A |
| PSD 更详细 | 只读不写；文本层只拿矩形不拿文字；调整层只认 `brit` 且烤进像素；组不结构化 | Phase B |
| UI 布局更合理 | 画布与助手抢空间；确认卡/执行卡/自检卡混在一条聊天流里；没有命令面板 | Phase C |
| 助手操作权限更大更多 | autonomous 只放行 `layer.update_text`；助手不能提 plan；Photoshop 只能手点 | Phase D |

---

## 1. 证据：五个参考仓库里真正能抄的

已逐份读过，结论按"能抄 / 不能抄"分开，避免把别人的产品假设搬进来。

### 1.1 `editorimage-ai-main`（pedit）——**命令面密度**的样板

- `backend/pedit/mcp_server.py` 暴露约 60 个工具，覆盖 project / layer / effect / mask / canvas / AI 六组。
  对照我们的 19 条，缺的正是它最密的那几组：
  `align_layer`、`duplicate_layer`、`group_layers` / `ungroup`、`merge_down`、`flatten`、`rasterize_layer`、
  `list_effects` / `add_effect` / `update_effect` / `remove_effect` / `move_effect`、`apply_look`、
  `set_mask` / `mask_stroke` / `update_mask`、`paint_stroke`、`crop_canvas` / `resize_canvas` / `resize_image`。
- `effects.py` 是一张**声明式效果注册表**：每个效果带 `kind`（filter/style）、`group`（color/detail/stylize/style）、
  `fn`、`desc`、`params`。→ 我们照这个形状做"可列可改可删的效果栈"，而不是再造一堆一次性命令。
- `_griglia()` 给预览叠坐标网格；`report_issue()` 让模型**结构化上报卡点**而不是编造成功。
  → 后者要抄：我们缺一个"我做不到，原因是 X"的正式出口。
- ✅ 抄：命令分组与效果注册表的形状、`align`、`report_issue` 的思路。
- ❌ 不抄：它把"项目文件"当唯一真相（自己的一套 JSON 工程格式）。我们是**活文档 + revision + digest**，
  这个模型更强，不能退回到"存文件再打开"。

### 1.2 `openfill-main` ——**结果落层 + 一次干净撤销 + 选择即蒙版**

- `photocraft/openfill_photocraft/service.py` 里最值钱的一句注释：
  > *"The document's history before the last job, and as the job and the picker left it: while it is still that,
  > Keep and Discard can take the result back and leave one clean step (Keep) or none (Discard) instead of
  > piling deletes on top."*
  → 它记**历史基线**，从而 `Keep` = 恰好一步、`Discard` = 零步。这正是我们 `history.batch` 想要但还没量化的语义：
  我们现在能保证"整串一条历史"，但**没有把"撤销后 contentDigest 复原"作为命令返回值**（只有 run_plan 有 `restored`）。
- README 的交互契约："the selection is the mask, the result is a layer you can paint on or delete"。
  → 我们已经做到（活蒙版 + 结果层）；但**没有把"结果层 id"稳定回给调用方**用于后续编辑。要补。
- `patchy/` 里有**完整的 PSD 写入器**（`psd.py`：`write` / `encode` / `_records` / `_blank_merged`，处理 layer records、
  通道 plane、`lsct` 分组块、Pascal + Unicode 双份图层名）。→ Phase B 的直接参考实现。
- `models/catalog.json`：每个模型带 `sha256` / `license` / `min_vram_gb` / `requires_nodes` / `tier`，
  下载后**校验再改名**。→ 我们不下载模型，但"后端能力声明必须带可校验元数据"这条要抄到 `generation` provider 描述里。
- ✅ 抄：历史基线 → Keep/Discard 语义、PSD 写入器、provider 元数据形状。
- ❌ 不抄：ComfyUI 全家桶 + 7z 安装器 + 窗口 tether（`tether.py` 靠找 PhotoCraft 窗口句柄贴靠）。
  我们是 iframe 内嵌，没有第二个进程窗口可贴。

### 1.3 `layershop-main` / `c-shop-main` / `scumble-main`（前两轮已记，要点复用）

- LayerShop：蒙版要**羽化**再送模型；"按钮变灰"必须说清是哪一条前置条件（→ 我们的 `disabledReason` 已经这样做了，继续保持）。
- C-Shop：`measure` 让看不见画布的调用方按数字排版（→ 我们的 `measure_text` 已有，Phase A 要把它扩到"整块文案框"）。
- Scumble：策略在宿主、作用在**规范化后的调用**上（→ 我们的 `gate.js` guard + `validateImageCommand` 已经是这个形状）。

---

## 2. Phase A — 让 miniPaint 更像"可被 DSH 编辑的文档"

### A1. 新增 11 条命令（按价值排序）

| 命令 | 参数 | 为什么 DSH 需要它 | 撤销语义 |
|---|---|---|---|
| `layer.align` | `layerId, h:left/center/right, v:top/middle/bottom, margin?` | 套版 90% 的时间花在"把这层对到槽位"。没有它，模型只能反复 `set_transform` 试坐标 | 一步 |
| `layer.duplicate` | `layerId, offsetX?, offsetY?, name?` | 做多槽位变体、做"同一元素第二份" | 一步 |
| `layer.set_effect` | `layerId, effect, params, index?, enabled?` | 非破坏调色/阴影/描边；对应 pedit 的 effect 栈。当前只有破坏性的 `layer.color_match` | 一步 |
| `layer.remove_effect` | `layerId, index` | 效果栈要能删 | 一步 |
| `layer.update_mask` | `layerId, invert?, density?` | 抠图后常见"蒙版反了/太硬"，现在只能重建 | 一步 |
| `layer.group` | `layerIds[], name?` | 结构可读；`read_state` 才有层级 | 一步 |
| `layer.ungroup` | `layerId` | 同上 | 一步 |
| `layer.merge_down` | `layerId` | 出成品前收口 | 一步（合并本身不可逆，但撤销可回） |
| `layer.rasterize` | `layerId` | 文字层转像素，替换/导出前的确定性 | 一步 |
| `layer.paint_stroke` | `layerId, points[], color, size, hardness, opacity` | 让模型能"画一笔"，覆盖 `mask.stroke` 的活（不用 `paint.*` 前缀：guard 只认 `layer./canvas./history.`） | 一步 |
| `document.settings` | `name?, background?, dpi?` | 画布元数据；Amazon 规范要 DPI/背景色可核对 | 一步 |

> 白名单从 19 → 30 条。每条都要同步四处：`lib/bridge.js`（字段校验）、`miniPaint/src/js/dsh-editor-bridge.js`（执行）、
> `lib/commands.js`（`enabled`/`disabledReason`）、`test/bridge.test.cjs` + `test/commands.test.mjs`。

### A2. `read_state` 变"够用"

- 每层多返回：`bounds`（画布坐标）、`coverage`（占画布面积比）、`mask`（是否有蒙版/invert/density/feather）、
  `effects[]`（栈）、`text`（真实文字 + 字体 + 字号 + 行高）、`parent`（组 id）。
- 新增 `safeArea`：按目标画幅算出的安全边距框（给 Amazon 主图/副图用），模型据此判断"会不会被裁掉"。

### A3. `analyze` 变"分区可量"

- 现在只有整图指标 + 图层体检。加 `regions[]`：按**每个槽位/每个图层的外框**分别量亮度、对比、是否越界，
  返回 `findings` 带 `layerId` 与可直接用的 `suggestedCommand`（含新命令）。
- `preview` 加 `crop`（`{x,y,width,height}` 只截那块放大看）与 `layerId` 单层渲染；
  加 `grid` 间距可调（现固定 100px）。

### A4. 结果可追溯

- 每条写命令回执增加 `changedObjectIds`（多数已有）与 **`restored`**：撤销后 `contentDigest` 是否复原。
- `layer.add_image` 回执固定返回**新层 id**（Phase A 前它是偶发的）。
- 批量/计划沿用一条历史；单命令回执附 `history.canUndo`。

**Phase A 验收证据**：新增 11 条命令各有单测；`bridge.test.cjs` 覆盖执行层；
一次 `layer.align + set_effect + group` 的 `run_plan` 之后 `history.undo` 让 `contentDigest` 复原；
`analyze` 的 `regions` 在真实 2000×2000 画布上给出与图层框一致的数值。

---

## 3. Phase B — PSD 更详细

### B1. 读得更细（`lib/psd.js` / `psd-effects.js`）

| 现在 | 目标 |
|---|---|
| 图层名（Pascal/Unicode 二选一） | 两份都读，优先 Unicode |
| 文本层只当普通像素层 | 解析 `TySh` 拿**真实文字内容 / 字体 / 字号 / 行距 / 对齐 / 颜色**，映射成 `layer.add_text` 的 style |
| 调整层只认 `brit` | 补 `levl`（色阶）、`curv`（曲线）、`hue2` / `hue `（色相饱和）、`expA`（曝光）、`blnc`（色彩平衡）、`mixr`（通道混合） |
| 组只靠 `lsct` 猜 | 结构化 `groups[]`：id、name、子层、展开态、混合模式、不透明度 |
| 不支持项只进 `approximated[]` | `approximated[]` 带 `layerId` + `kind` + `reason`（三类：不支持的模式 / 不支持的调整、被烤平的效果 / 未解析的块） |
| 无矢量蒙版 | 解析 `vmsk` / `vsms`，作为 `mask.invert/density` 传给 `layer.update_mask` |

#### B1 进度（v0.43.0）

| 项 | 状态 | 说明 |
|---|---|---|
| 文本层真实文字内容 | ✅（本来就有） | `Txt ` 字段 + 标记兜底；`\r`→`\n`、去尾 NUL |
| 文本层字号 / 字体 / 对齐 / 颜色 / 行距 | ✅ | 真正的数据在 **EngineData**，不在描述符里（见下） |
| `textSampled: 'first-run'` | ✅ | 一个文字层可能有多段 run；这些值是第一段的，如实标注口径 |
| 组结构 `groups[]` | ✅ | 见下方「B1 组结构」：只在 lsct 两种标记能配对时成组，配不上就登记 warning |
| 调整层 `levl`/`curv`/`hue2`/`expA`/`blnc` → `layer.set_effect` | ⛔ 阻塞 | **本机两个真实样例里没有任何调整层**，没有可验证的输入，见下方说明 |
| `approximated[]` 带 `layerId + kind + reason` | ⬜ | |
| 矢量蒙版 `vmsk` / `vsms` | ⬜ | |

**B1 组结构（v0.44.0）**：`parsePsdLayers` 现在返回 `groups` 与 `groupWarnings`，`psdToTemplate` 把它们连同每槽位的 `group`
一起给出。判定规则按 PSD 文件顺序（从下往上）：`分隔符(type 3) → 组内图层 → 组结束标记(type 1/2)`。
**只在两者一一配对时确认成组**；出现孤儿标记 / 未闭合 / 重复分隔符时登记 `PSD_GROUP_ORPHAN` / `PSD_GROUP_UNCLOSED` /
`PSD_GROUP_UNBALANCED`，成员不归属任何组 —— 错的分组比没有分组更糟，因为套版会按组批量替换。

真实样例结果可直接交叉印证：aplus01 解析出 1 组「1」（含 10 层，背景层在组外）；
detail01 解析出 2 组「细节图」（4 个图片层）与「文案」（3 个文字层），两文件均**零 warning**。

**为什么调整层没做**：本机两个真实 PSD（`aplus01` / `detail01`）里**一个调整层都没有**（无 `levl`/`curv`/`hue2`/`expA`/`blnc`/`mixr`）。
按 PSD 规范把六种块盲写出来，只能证明"我按自己的理解编码、又按自己的理解解码"——
那不叫验证，正是本项目一直避免的那种"未经验证的宣称"。要推进这一步，需要一个**含调整层的真实 PSD**作为输入；
在拿到之前，`psd-composite.js` 对调整层的处理维持原状（`brit` 会作用，其它块交给调用方登记）。

**关键发现（值得记住）**：真实 PSD 上 `parseDescriptor` 会抛 `PSD_BAD_KEY`。也就是说**严格描述符路径在真文件上一直是失败的**，
只是一直静默退到标记扫描，所以 `fontSize`/`fontName` 长期为 `null` 而没人发现。

真正的排版数据在 `TySh` 的 **EngineData 块**里，是明文 ASCII 键值：

```
/FontSize 50.0     /Justification 0     /Font 0
/Leading 48.2091   /FillColor << /Type 1 /Values [ ... ]
/FontSet [ << /Name (þÿ\0P\0o\0p\0p\0i\0n\0s…) >> ]
```

其中 `/Name` 的字体名是**括号内的 UTF-16BE**（前缀 `FE FF`），不是 `/Name /Foo` 形式 —— 这点搞错会一直拿到 null。
按这些标记取值后，两个真实样例分别解析出 `Poppins-Medium/Regular` 与 `Roboto-Bold/Medium`，
字号、对齐、颜色、行距各不相同，可交叉印证不是同一个全局值。

**刻意没做**：这些排版属性还没接进套版（`layer.add_text` 的 `style`）。因为要先解决字体注册——
把 PSD 里的 `Poppins-Medium` 直接当 `family` 传进去，编辑器在没注册时会静默回退，等于假装保真。
这一步并入 B3（文字槽位）一起做。

### B2. 写得出来（新）

**实现位置改了（重要）**：计划里写的是宿主侧 `lib/psd-write.js`，实际做成了
`miniPaint/src/js/dsh-psd-write.js`。原因是宿主的 relay 有 **64 KiB 消息 / 256 KiB 响应**上限，
整层像素根本过不去；而画布与图层像素本来就在编辑器页面里。导出沿用现有链路
（`editor.export_start` 产出 blob URL），所以不需要新开二进制通道。

- `buildPsd({width,height,layers,composite})`：纯 ESM、**不依赖任何浏览器 API**（只吃 RGBA 数组），
  因此宿主侧测试可以直接 import 它、再用 `lib/psd.js` 读回来做往返验证。
- 写入内容：图层记录（矩形 / 4 通道 alpha+R+G+B / 混合模式键 / 不透明度 / 可见 flags）、
  Pascal 名 + `luni`（中文名正确往返）、PackBits RLE 通道数据、合成图平面。
- `media_image_export_start { format: 'psd' }` 已开放（`png`/`jpeg` 仍是拼平位图）。
- **回执里如实登记降级项**（`approximations[]`：`rasterized` / `mask-baked` / `clipped` / `off-canvas`），
  导出结果还带 `layerCount`。页面下载也把这两项回传给调用方——否则用户会以为拿到了完全可编辑的工程文件。
- 边界：**只写我们自己合成出来的东西**。文字/矢量层栅格化，活蒙版烤进像素，图层矩形夹到画布内，
  不写智能对象/图层样式/调整层。

**验收证据**：往返测试 6 条——头部/图层数/名称/矩形/不透明度/混合模式/可见性全部一致；
中文图层名经 `luni` 往返正确；RLE 通道解码后的 R 平面与写入值逐像素相等（用独立写的解码器，不复用写入器代码路径）；
空图层列表也能产出可解析文件；以及**用真实 aplus01.psd 的图层元数据重写一份、读回后与原文件逐层一致**。

**踩到的真 bug（值得记住）**：第一版用 `push(...bigArray)` 拼接通道数据。
单元测试最大只到 64×48，全部通过；但生成一份 970×600 的真实测试文件时立刻
`RangeError: Maximum call stack size exceeded` —— **任何实际尺寸的导出都会直接崩**。
改成 `Uint8Array` 分块 + `concatBytes()` 顺序拼接，并补了一条 800×600 的回归测试：
它断言文件达到真实量级、能解析、且抽三行像素核对通道位置正确。
教训是：小尺寸夹具只能证明算法对，证明不了能跑真实规模。

**没验证的**：Photoshop 能否打开我们写出的文件——这一步需要人工点开一次，测试里不假装。

### B3. 套版链路用上新 PSD

- 从 PSD 读到文本层 → 生成"可替换文字槽位"清单（字号/对齐/颜色已知），
  套版时用 `layer.update_text` 直接改字，**不再把文字烤成图片**。
- 从 PSD 读到调整层 → 转成 `layer.set_effect` 的非破坏效果栈（而不是烤进像素）。

#### B3 进度（v0.46.0）

| 项 | 状态 | 说明 |
|---|---|---|
| 文字不烤图 | ✅（本来就这样） | `buildTemplateBase` 合成底图时会**排除文字层**，文字由 `layer.add_text` 重新排，不是贴图 |
| 沿用 PSD 字号 | ✅ | `style.size` 默认取 `slot.fontSize`，调用方仍可用 `textStyle.size` 覆盖 |
| 沿用 PSD 颜色 | ✅ | `style.fill_color` 默认取 `slot.fillColor`（之前只有调用方显式传才生效，PSD 里量到的颜色被丢掉了） |
| 字体解析 | ✅ | `fonts.matchFontName()`：整串精确 → 拆 `Family-Style` 取家族 → 前缀匹配；命中才给 `family` + `fontUrl` |
| 字体缺失时如实告知 | ✅ | 没命中就不写 `family`/`fontUrl`，并登记 `FONT_UNAVAILABLE` warning；`summary.fontsMissing` 计数，命令 `note` 也标"字体未登记，已回退" |
| 调整层 → `set_effect` | ⛔ | 仍缺含调整层的真实 PSD（见 B1 说明） |

**为什么字体这件事必须显式做**：把 PSD 里的 `Poppins-Medium` 直接当 `family` 传给编辑器，
在字体没登记时 canvas 会**静默回退**到默认字体——画面看起来"成功"了，字体其实已经丢了。
那不是保真，是假装保真。所以：能给可加载 URL 才写，给不出就报缺失。

`/template/apply`、`/template/plan`、`/template/batch` 三条路由都已接上 `resolveFont`；
批量套版把解析器透传给每一份规划。

**没验证的**：`fontUrl` 真正加载后的**字形**是否与 Photoshop 一致——这需要真实字体文件与人工目视比对。
测试验证的是"命中/未命中/URL 形状/命令里带没带"这些可核对的事实。

**Phase B 验收证据**：一个带文本层 + 组 + 图层面板的真实 PSD，读出的 `text` 与 Photoshop 里一致（人工比对一次）；
我们导出的 PSD 能被 Photoshop 打开且图层数/名称/蒙版与 `read_state` 一致；`approximated` 里每项都有 layerId+reason。

---

## 4. Phase C — UI 布局

### C1. 三栏 + 可折叠助手

```
┌─────────┬──────────────────────────┬───────────────┐
│ 图层/素材 │          画布             │   助手（可折叠） │
│ (260px) │        (flex-1)          │   (360px)     │
│         │                          │  ┌──────────┐ │
│         │                          │  │ 待确认卡片 │ │
│         │                          │  ├──────────┤ │
│         │                          │  │ 执行结果   │ │
│         │                          │  ├──────────┤ │
│         │                          │  │ 自检数值   │ │
│         │                          │  └──────────┘ │
├─────────┴──────────────────────────┴───────────────┤
│ 历史条（可点跳转）+ revision + contentDigest 前 8 位    │
└────────────────────────────────────────────────────┘
```

- 助手面板可折叠成 44px 图标条（`prefers-reduced-motion` / 窄屏默认折叠）。
- 确认卡、执行卡、自检卡**分卡片**，不再挤在一条消息流里；卡片带 `revision` 与 `digest` 便于核对。
- 底部历史条：显示最近 N 条，点一条 → `history.undo` 到该点（复用现有守卫凭据）。

### C2. 命令面板（⌘K / Ctrl+K）

- 直接吃 `media_image_list_commands` 的输出：每条显示 `params` 契约与**当前** `enabled`/`disabledReason`。
- 点一条 → 自动按当前 `read_state` 预填参数 → 走同一份 `apply_command`（**UI 与 Agent 同一条路**，这是 Scumble 那条教训）。
- 面板顶部显示"哪些是被前置条件挡住的"，避免第 N 次踩同一个 `no-selected-layer`。

### C3. 主题

- 已有 `dsh-theme.css` + `--dsw-alias-*` 映射；补齐新面板/卡片的 token，避免出现硬编码色。
- 深浅色都要过一遍对比度（`analyze` 的 `TEXT_LOW_CONTRAST` 规则也适用于 UI 文本，人工核对）。

**Phase C 验收证据**：1440×900 与 1024×700 两张截图；折叠/展开不重排画布；
命令面板在"没选图层"时对 `layer.feather` 显示 `no-selected-layer` 且不可点。

---

## 5. Phase D — 助手权限更大更多（含安全边界）

### D1. 扩大自主白名单（`lib/gate.js` `AUTONOMOUS_CAPABILITIES`）

**已按本人授权放开到全部内置命令**（2026-11 策略变更，见下）。当前 `autonomous` 可执行：
`layer.add_text`、`layer.update_text`、`layer.set_appearance`、`layer.set_visibility`、
`layer.set_transform`、`layer.set_frame`、`layer.align`、`layer.reorder`、`layer.feather`、
`layer.color_match`、`layer.add_image`、`layer.remove`、`layer.remove_background`、
`layer.magic_erase`、`layer.add_mask_layer`、`canvas.crop`、`canvas.resize`、
`history.undo`、`history.redo`、`history.batch`，以及**任何内置 Photoshop action**。

> ⚠️ 这是一次**有记录的策略选择，不是护栏被误删**。原先这些命令在 autonomous 下被拒、在 assist 下必须逐次审批，
> 理由是"删数据/引入外部像素/烤平不可逆"。本人权衡后要求放开。仍然成立的技术事实：
> - miniPaint 侧每条形如上述的命令**仍各自占一条原生历史记录**，`history.undo` 能回；
> - **Photoshop 侧不在我们的撤销栈里**，回退要在 Photoshop 内手动做；
> - 任意 JSX 已按本人要求重新开放（见 §7），它与固定 action 的差别是"脚本内容由调用方给"。

`NEVER_AUTONOMOUS`（`lib/gate.js`）保留为**临时收紧旋钮**：把某条命令加进这个集合即可在 autonomous 下重新拒绝，
优先级高于白名单，不必从白名单里删（删了会丢信息）。当前为空集。

理由（更新后）：白名单覆盖全部命令，保证"能执行就能自主执行"，不存在模型试半天才发现被策略挡住的命令。

### D2. 助手可以提 plan

- `assist.js` 已修好 `OP_TYPES` 漏 `plan` 的 bug（原先提示词教模型提 plan，`parsePlan` 却把它丢掉）。
- 助手提议的 `plan`：1..12 步、步骤必须是白名单命令；`run_plan` 另有一道 `AUTONOMOUS_STEP_DENIED` 闸门，
  只有被 `NEVER_AUTONOMOUS` 单独收紧的步骤才会被整串拒绝。

### D3. 助手能自己跑"读—改—量"闭环

- 给助手一个**受限的工具循环**：`read_state` → `run_plan`（自主白名单内）→ `analyze` → 若 `findings` 未清则再一轮，
  最多 3 轮，每轮必须写 `progress`。任一轮 `status !== 'applied'` 立即停并如实回报。
- 这是"助手权限更大"的核心：不是给更多高危命令，而是允许它**连续做可逆的小步并自检**。

### D4. Photoshop：助手提议 → 自主执行（assist 仍人审）

- 已修：助手现在能提 `photoshopAction`（`OP_TYPES` + `validOp` + SYSTEM 提示词 + 页面确认卡 + 宿主审批）。
- **2026-11 策略变更**：autonomous 下任何内置 action 不再等审批，回执带 `autonomous: true` 与"回退要手动"的说明；
  assist 模式保持逐次人工审批。`confirm: true` 仍是写 action 的硬门槛（它是调用方的显式声明）。
- 保持：不共享撤销栈；超时是 `PHOTOSHOP_RESULT_UNKNOWN` 不重试；任意 JSX 走 `media_image_photoshop_run_jsx`（`confirm:true` 硬门槛，脚本原样交给 `DoJavaScript`，无沙箱无自动回滚）。

### D5. `report_issue` 出口

- 新命令 `editor.report_issue`（只写日志 + 返回 issueId，不改画布）：模型遇到"工具不支持/前置条件不满足/结果和预期不符"时，
  走这条正式出口而不是编造成功。对应 pedit 的 `report_issue`。

**Phase D 验收证据**：autonomous 下 `layer.align` 与 `layer.remove` 都成功（各一条测试）、
`NEVER_AUTONOMOUS` 收紧后 `AUTONOMOUS_STEP_DENIED`；
autonomous 的 Photoshop 写不触发审批且回执标 `autonomous`（`photoshop-com.test.mjs`）；
助手跑完一次 3 轮闭环的完整 transcript（含 progress 与 analyze 数值）；
`report_issue` 落一条可查记录。

---

## 6. 顺序、批次与回退

### 已完成（v0.37.0）

| 批次 | 内容 | 证据 |
|---|---|---|
| Photos: 固定 action 接线 | 宿主路由统一到 `/media-image/photoshop/action`；`confirm` 不再混入命令参数；`gate.js` 工具名收敛；助手能提 `photoshopAction` | `photoshop-com.test.mjs` / `assist-photoshop.test.mjs` |
| D1 自主白名单扩容 | `AUTONOMOUS_CAPABILITIES` 1 → 8 条可逆属性编辑；新增 `NEVER_AUTONOMOUS` 黑名单且**优先级更高** | `smoke.test.mjs` 双向矩阵 + 运行时污染测试 |
| D2 助手可提 plan | 修掉 `OP_TYPES` 漏 `plan`/`photoshopAction` 的真实 bug（提示词教模型提、`parsePlan` 却丢弃）；`plan` 加形状校验 | `assist-photoshop.test.mjs` |
| `run_plan` 自主闸门 | 自主模式下每步都必须在白名单内，否则 `AUTONOMOUS_STEP_DENIED`，一条都不发 | `plan.test.mjs` |
| A1 首条命令 `layer.align` | 编辑器算 x/y，回执带 `detail.aligned`；旋转层如实标注 | `bridge.test.cjs` 43 项 / `image-contract.test.mjs` |
| A4 回执可信 | `detail` 进工具结果 + 渲染文本，省一次 `read_state` | `image-contract.test.mjs` |

### A2 / A3 进度（v0.41.0）

| 项 | 状态 | 说明 |
|---|---|---|
| `read_state` 每层 `bounds` | ✅ | `{x,y,width,height,right,bottom}`，不用再从 `x/y/width/height` 自己算 |
| `read_state` 每层 `coverage` | ✅ | 按**帧 ∩ 画布**算，溢出部分不计、不会出现 >1；配合 `offCanvas` |
| `read_state` 每层 `mask` / `effects` / `text` | ✅ | 改完能读回来自证 |
| `read_state` `parent`（层级） | ⛔ | 与 `group` 同因：miniPaint 没有组概念 |
| `analyze` `regions[]` | ✅ | 每个可见图层外框分别量 `canvasShare` / `opaqueRatio` / `meanLuma` / `lumaStdDev`；只量面积最大 24 个，`regionsTruncated` 报剩余 |
| 新 finding `REGION_NOT_VISIBLE` | ✅ | "占画布 ≥2% 但该块几乎没内容" → 建议 `layer.reorder`（多半被上层压住） |
| `preview` 的 `crop` / 单层渲染 / grid 间距 | ✅ | `crop{x,y,width,height}` 局部放大（越界夹紧并回报实际矩形）、`layerId` 只渲一层、`gridStep` 8..2000 且标注源图坐标；回执带 `crop`/`scale` 用于坐标换算 |

**注意（代价）**：`read_state` 每层多了约 8 个数字，40 层的 payload 会大一些。真到要省 token 时再加 `detail` 开关——先测量，别先优化。

### A1 命令进度（v0.38.0 → v0.40.0）

| 命令 | 状态 | 说明 |
|---|---|---|
| `layer.align` | ✅ | 编辑器算 x/y，回执带 `detail.aligned`；旋转层如实标注 |
| `layer.duplicate` | ✅ | 偏移量相对原层；活蒙版配置跟着复制；不搬 `link` |
| `layer.rasterize` | ✅ | 走编辑器自己的 `render_object`；旋转与活蒙版烤进像素后，新层不带 rotate/params |
| `layer.merge_down` | ✅ | 先下后上合成整块画布；最下层回 `NO_LAYER_BELOW`，不静默无操作 |
| `layer.paint_stroke` | ✅ | 图层本地坐标；在现有像素上叠加；一笔一步撤销 |
| `layer.set_effect` / `layer.remove_effect` | ✅ | 非破坏效果栈：`params.dshEffects` → 渲染时翻译成 canvas `ctx.filter`（顺序固定）。词表 blur/brightness/contrast/saturate/grayscale/sepia/invert/hueRotate/opacity；宿主与编辑器两份表有逐项比对测试 |
| `layer.group` / `layer.ungroup` | ⛔ | **重新分类：不是"加命令"**。`parent_id` 在整个 miniPaint 里只在 `Insert_layer_action` 的默认值和一处注释里出现，渲染/排序/任何 action 都不读它 —— 没有"组"这个概念。要做就得先造结构 + 改渲染 + 改 `read_state`，属于独立特性 |
| `layer.update_mask` | ✅ | 只做**活蒙版真的会读**的部分：`invert` / `sourceLayerId` / `remove`。`mode`/`featherPx` 显式拒绝（活蒙版渲染不读它们，收下就是骗人）。成环由 `MASK_CYCLE` 拦截；`read_state.mask` 现在也报 `invert` |
| `document.settings` | ⏸ | miniPaint 没有 dpi/文档名概念，硬加等于发明元数据；等真有需求再做 |

**已经踩过的坑（写下来免得再犯）**：
- `Insert_layer_action` 对 `type:'image'` 会用 `new Image()` 解码 `data`，所以测试里的图层必须带 `data`（真实图层都有）。
- `Delete_layer_action` 会 `parseInt(layer_id)`：**图层 id 必须是整数**，用字符串 id 的测试数据会得到 "Layer to delete not found"。
- 编辑器源码是 UTF-8 无 BOM：**不要用 PowerShell 的 `Set-Content`/`-replace` 批量改写**（PS 5.1 按 ANSI 读写，中文会整片毁掉）。只用 edit 工具。

### 待做

| 批次 | 内容 | 预计改动面 | 回退方式 |
|---|---|---|---|
| **v0.38.0** | Phase A1 前五条命令（align + duplicate/rasterize/merge_down/paint_stroke）+ A2/A3 | `bridge.js`、`miniPaint/…/dsh-editor-bridge.js`、`commands.js`、bundle 重建 | 命令是新增，旧命令不受影响；出问题可只回退白名单 |
| **v0.39.0** | Phase A1 效果栈（`set_effect`/`remove_effect`）+ 渲染管线接 `ctx.filter` | `base-layers.js` 渲染、`dsh-editor-bridge.js`、`bridge.js`、bundle 重建 | 只在 `params.dshEffects` 存在时才设 filter；没设过的图层行为完全不变 |
| **v0.39.1** | Phase B1（读得更细） | `psd.js`、`psd-effects.js` | 解析失败仍登记 `LAYER_EFFECTS_UNPARSED`，不毁底图 |
| **v0.40.0** | Phase B2（PSD 写入）+ B3（文字槽位） | 新增 `psd-write.js` | 新能力，不接就不可用 |
| **v0.40.1** | Phase C1/C2/C3（UI） | `scripts/image-page/*`、`dsh-theme.*` | UI 纯前端，回退文件即可 |

每批都要走完整发布纪律（版本源 → `sync-version` → `npm run build` → `pack-image` → `npm test` → `npm pack` → 部署 → commit/tag/push/Release）。

## 7. 原先"不做"、现已按本人要求改做的四条

本人把上一版这四条从"不做"改成"明确做"。逐条落地情况：

| 条目 | 状态 | 说明 |
|---|---|---|
| 接入真重绘模型（ComfyUI） | **已具备，待配置后端** | `lib/generation.js` 的 `createComfyUiProvider` 早就实现了 `startInpaint`（源图/蒙版上传 → 注入 `editImageNode`/`editMaskNode` → `/prompt` → `/history` → `/view`）。本轮补上**可直接用的工作流预设** `presets/comfyui-inpaint-sd15.json` + 配置文档 `docs/comfyui-inpaint.md` + 5 条预设回归测试（含"注释键会被当成假节点送进 ComfyUI"这类坑）。仍然**没有**在本机跑过真实 ComfyUI —— 所以 `/inpaint` 继续如实报"缺后端"。 |
| 任意 JSX 暴露给 Agent | **已完成** | `media_image_photoshop_run_jsx`（`jsx` 1..65536 字节 + `confirm:true`）。桥接里 `run_jsx` 分支**不经过** PowerShell 的 JSON 插值模板，脚本原样交给 `DoJavaScript`；有测试断言它不出现在进程命令行、也不进 here-string。 |
| 承诺 Amazon 合规 | **不按字面做，改为"量事实 + 不认证"** | 见下方说明。 |
| 把不可撤销命令放进自主白名单 | **已完成（上一轮）** | `AUTONOMOUS_CAPABILITIES` 覆盖全部内置命令；`NEVER_AUTONOMOUS` 保留为临时收紧旋钮。 |

### 关于"承诺 Amazon 合规"

这一条我不按字面实现，原因不是不想做，而是**代码无法承诺政策合规**：

- Amazon 的图片政策按**站点、类目、时间**变化，且由人工审核判定；任何本地检查器给出的"合规"都是没有任何效力的宣称。
- 本项目已有的纪律是"不把宣传话术/未验证能力当事实"。输出一个 `compliant: true` 正好是这条纪律的反面。

**可交付的等价物**（建议下一步就做，需要编辑器侧补测量）：

1. 编辑器 `analyze` 增加 Listing 专用测量：边框环的白底纯度、主色饱和度、主体占画幅比例（角点背景洪泛）、长边像素、画幅比例。
2. 新模块 `lib/amazon-listing-check.js`：把测量结果对一张**带来源**的规则表打分，每条规则给
   `pass` / `fail` / `unknown` + `evidence` + `source`；顶层固定 `certification: 'not-possible'`，
   只输出"哪些规则没过/量不到"，永远不输出"合规"。
3. 工具 `media_image_check_listing_image`，回执里第一条永远是"这是自检，不是 Amazon 审核结论"。

这做出来是**可核对的**（每条结论都有像素证据与规则来源）；"承诺合规"做不出来。

其余仍然不做：
- **不做 Photoshop 与 miniPaint 的跨应用事务**。两者各自一条历史，回执里必须写清"不共享撤销栈"。

## 8. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 命令面扩张导致 `read_state` 变大 | 每次调用的 token 成本上升 | 分层返回：`read_state` 默认 `detail:normal`，`detail:'full'` 才给 effects/text/bounds |
| 效果栈与"烤进像素"两套模型并存，语义打架 | 用户分不清哪个能改回来 | 回执显式标 `baked: true/false`；`analyze` 对烤平的层给提示 |
| PSD 写入与 Photoshop 解析预期不一致 | 用户打不开 | 用真实 Photoshop 打开一次做人工验证；不一致就降级为"仅 PNG + 图层清单 JSON" |
| 自主白名单放大后被滥用 | 数据丢失 | 白名单全部可逆 + `history.undo` 凭据校验 + 每轮 progress 留痕；破坏性命令一律人工 |
