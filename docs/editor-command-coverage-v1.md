# 编辑器命令覆盖率基准 v1（图片：miniPaint）

> 用途：这是「Agent 能操作编辑器按钮」的**覆盖率基准**。FDE 按本表逐项走查，
> 缺项必须在这张表里可见并写明理由，不接受"大概支持了"。
> 范围：仅图片编辑器；视频侧另出。写作时只读界面源码（`config-menu.js`、`config.js`、`gui-*`），未改代码。

## 0. 口径

1. **「按钮级」= 一条命令能复现用户点这个按钮的结果**，不是复现拖拽轨迹。
2. 每条命令三种状态之一：
   - **写文档**：`revision + 1`，进原生历史（`historyEntry:true`）；
   - **不写文档**：改的是视图/工具/颜色等瞬时态，`revision` 不变，回执必须显式 `historyEntry:false`；
   - **不做**：在 §5 列理由。
3. 不开任意 JS。所有命令进白名单，有 schema 与参数校验；`editor.*` 只承载界面级操作，不承载"执行脚本"。
4. 现有命令（`layer.add_text/update_text/add_image/set_frame/feather/color_match/set_transform/set_visibility/reorder/remove`、`canvas.resize/crop`、`history.undo/redo`）保持兼容，不重命名。

## 1. P0：本轮必须做（Chief 已定）

| 界面项 | 命令 | 关键参数 | 写文档 | 备注 |
|---|---|---|---|---|
| 图层→新建 | `layer.add_blank` | `type:'empty'\|'raster'`, `name?` | ✅ | 对应 `Insert_layer_action` |
| 图层面板→复制 | `layer.duplicate` | `layerId` | ✅ | |
| 图层→删除 | `layer.remove` | `layerId` | ✅ 已有 | 高风险，需审批 |
| 图层→上移/下移 | `layer.reorder` | `layerId,toIndex` | ✅ 已有 | 界面是 ±1，语义是绝对位次 |
| 图层→显隐 | `layer.set_visibility` | `layerId,visible` | ✅ 已有 | |
| 图层面板→名称 | `layer.set_properties` | `layerId,name?` | ✅ | |
| 详情→不透明度 | `layer.set_properties` | `layerId,opacity 0..100` | ✅ | `Update_layer_action` |
| 图层→Composition | `layer.set_properties` | `layerId,composition` | ✅ | 混合模式，枚举白名单（见 §4） |
| 文本→新增 | `layer.add_text` | 已有 | ✅ 已有 | |
| 文本→改文字 | `layer.update_text` | 已有 | ✅ 已有 | |
| 文本→字体/字号/颜色/加粗/斜体/对齐 | `layer.set_text_style` | `layerId,size?,family?,color?,bold?,italic?,align?` | ✅ | 只对 text 层生效 |
| 形状→新增 | `layer.add_shape` | `shape,x,y,width,height,fill?,stroke?,strokeWidth?,radius?,points?` | ✅ | `shape` 取 §4 枚举 |
| 历史→撤销/重做 | `history.undo/redo` | 已有 | ✅ 已有 | |
| 视图→缩放 | `editor.set_option` | `zoom: number\|'in'\|'out'\|'fit'\|'original'` | ❌ `historyEntry:false` | 纯视图 |
| 工具栏→选工具 | `editor.set_option` | `tool` | ❌ `historyEntry:false` | 选工具不改文档 |
| 文件→导出 | `media_image_export_start` | `format:'png'\|'jpeg'\|'webp'` | ❌ | 新增 webp；导出不改 revision |

## 2. P1：接完 P0 再做

| 界面项 | 命令 | 关键参数 | 写文档 |
|---|---|---|---|
| 图层→清空 | `layer.clear` | `layerId` | ✅ |
| 图层→转为栅格 | `layer.rasterize` | `layerId` | ✅ |
| 图层→向下合并 | `layer.merge_down` | `layerId` | ✅ |
| 图层→拼合图像 | `layer.flatten` | — | ✅ |
| 图层→选区新建 | `layer.add_from_selection` | `name?` | ✅ |
| 图层→差异向下 | `layer.difference_down` | `layerId` | ✅ |
| 图片→画布尺寸 | `canvas.resize` | 已有 | ✅ 已有 |
| 图片→裁剪 | `canvas.crop` | 已有 | ✅ 已有，需审批 |
| 图片→缩小/放大图片 | `image.resize` | `width,height,mode:'resample'\|'stretch'` | ✅ |
| 图片→旋转 | `image.rotate` | `angle:90\|180\|270\|-90`, `mode:'expand'\|'crop'` | ✅ |
| 图片→翻转 | `image.flip` | `axis:'horizontal'\|'vertical'` | ✅ |
| 图片→平移 | `image.translate` | `x,y` | ✅ |
| 图片→自动调整 | `image.auto_adjust` | — | ✅ |
| 图片→色彩校正 | `image.color_corrections` | `brightness,contrast,saturation,shadows,highlights` | ✅ |
| 图片→减色 | `image.decrease_colors` | `count 2..256`, `dither` | ✅ |
| 图片→修剪 | `image.trim` | `tolerance` | ✅ |
| 图片→信息/直方图 | `image.inspect` | `kind:'info'\|'histogram'` | ❌ 只读 |
| 图层→添加滤镜 | `layer.add_filter` | `layerId,filter,params` | ✅ |
| 图层→删除滤镜 | `layer.remove_filter` | `layerId,filterId` | ✅ |
| 特效→单个滤镜 | `editor.apply_filter` | `filter,params[],target:'layer'\|'canvas'` | ✅ 一次动作，一次撤销 |
| 选择→全选/清除 | `selection.set` | `mode:'all'\|'none'\|'rect'\|'alpha'` | ❌ 选区是瞬时态 |
| 选择→删除选区内容 | `selection.delete` | — | ✅ |
| 选择→复制/粘贴 | `selection.copy` / `selection.paste` | `x?,y?` | 复制❌ / 粘贴✅ |
| 颜色→前景/背景 | `editor.set_option` | `primaryColor,secondaryColor,swap?,reset?` | ❌ |
| 视图→网格/标尺/参考线 | `editor.set_option` | `grid,ruler,guides` | ❌ |
| 视图→全屏 | `editor.set_option` | `fullscreen:boolean` | ❌ |
| 文件→新建 | `document.new` | `width,height,background` | ✅（重置文档，需审批） |
| 文件→导入 PSD | `document.import_psd` | `sourceRef` | ✅（已有 UI 通路，缺命令化） |

## 3. 明确不做（附理由）

| 界面项 | 理由 |
|---|---|
| 画笔 / 铅笔 / 橡皮 / 克隆 / 渐变 / 模糊锐化涂抹 / 膨胀收缩 | 是**轨迹类工具**，一条命令无法表达合理语义（要么画一笔要么画一片）。Agent 只能"选工具"，落笔仍由人做。要做需另立 `editor.stroke{points}` 且先定义重采样与压感，超出本期。 |
| 裁剪工具（拖拽框）| 走 `canvas.crop` 已覆盖语义，工具本身是交互，不另做。 |
| Effect browser（特效浏览器）| 需要人眼看预览再选参数，命令化后参数空间爆炸且无法验证效果；改为 `editor.apply_filter` 定参调用。 |
| 外部工具（TINYPNG / REMOVE.BG / PNGTOSVG / SQUOOSH）| 依赖第三方联网服务，与"离线可用"冲突，且是外部副作用。 |
| 文件→打开 URL / 打开目录 / 摄像头 / 打印 | 浏览器权限与设备相关，Agent 无稳定语义；打印产物不可回读。 |
| 文件→另存为 / 另存为 Data URL | 与导出重复，且 File System Access 需要用户手势；统一走 export。 |
| 文件→快速保存 / 快速加载 | 落 LocalStorage/IndexedDB，跨会话语义未定义（工程重开本来就没验过），本期不做。 |
| 图片→颜色调色板 | 是取色工具，非文档修改；`image.inspect` 可给主色，但本期不做。 |
| Tools→Sprites / Key-Points / Content Fill / Color Zoom | 需要模型或交互式取样，本期不做。 |
| 动画（GIF 帧）| 多帧模型未在我们工程里定义，超出本期。 |
| 语言 / 设置 / 帮助 / 关于 / 快捷键 / 报告问题 | 与文档无关，且切换语言会影响我们注入的中文文案。 |
| 搜索图像 / 打开测试模板 | 依赖外部图库，离线不成立。 |

## 4. 枚举白名单

**`composition`（混合模式）**：`source-over`、`source-atop`、`source-in`、`source-out`、`destination-over`、`destination-atop`、`destination-in`、`destination-out`、`lighter`、`copy`、`xor`、`multiply`、`screen`、`overlay`、`darken`、`lighten`、`color-dodge`、`color-burn`、`hard-light`、`soft-light`、`difference`、`exclusion`、`hue`、`saturation`、`color`、`luminosity`。

**`shape`**：`rectangle`、`ellipse`、`triangle`、`right_triangle`、`romb`、`parallelogram`、`trapezoid`、`plus`、`pentagon`、`hexagon`、`star`、`heart`、`cylinder`、`human`、`tear`、`cog`、`moon`、`callout`、`arrow`、`line`、`bezier_curve`、`polygon`。

**`filter`（特效菜单实际条目）**：`gaussian-blur`、`brightness`、`contrast`、`grayscale`、`hue-rotate`、`negative`、`saturate`、`sepia`、`shadow`、`black-and-white`、`borders`、`blueprint`、`box-blur`、`denoise`、`dither`、`dot-screen`、`edge`、`emboss`、`enrich`、`grains`、`heatmap`、`mosaic`、`night-vision`、`oil`、`pencil`、`sharpen`、`solarize`、`tilt-shift`、`vignette`、`vibrance`、`vintage`、`zoom-blur`，另有 Instagram 九档（`1977/aden/clarendon/gingham/inkwell/lofi/toaster/valencia/xpro-ii`）。

## 5. 铁律

1. **一条命令 = 一个原生动作 = 一次 revision**。`editor.apply_filter` 传多个滤镜时必须包成一个 `Bundle_action`，否则撤销一次只退一个滤镜。
2. **非文档操作必须自报**：回执里 `historyEntry:false`，且 `revision` 原样返回（不 +1）。视图类命令不得夹带文档修改。
3. **像素类命令（滤镜/色彩校正/减色）必须幂等**：从"首帧快照"重算，与 `layer.feather/color_match` 同一套 `pixelBases` 机制；重算前若快照不存在则建立。
4. **批量/破坏性操作需审批**：`layer.remove`、`canvas.crop`、`document.new`、`layer.flatten`、`layer.merge_down`。
5. **不做"万能命令"**：不允许 `editor.run({name})` 这种按名字反射调用的入口，等价于开任意 JS。

## 6. 验收口径

- 覆盖率 = 本表所有 ✅/❌ 行的**已实现数 / 总数**，按界面分组统计，不接受按命令数汇报。
- 每一项判据是**双路径一致**：面板点一次的结果 vs 会话里让模型做一次的结果，`revision` 增量、画布像素、图层面板显示三者一致。
- 非文档命令额外判据：`revision` **没有**变化，且回执 `historyEntry:false`。

## 7. 口径

- **observed**：菜单项与工具栏项清单（`config-menu.js`、`config.js`）、图层面板动作
  （`gui-layers.js:58-105`：新建/上移/下移/显隐/删除/选择）、不透明度与属性写回
  （`gui-details.js:43,233,516`）、混合模式枚举来源（`modules/layer/composition.js:52`）。
- **derived**：命令拆分、P0/P1 划分、不做项理由、`historyEntry:false` 规则。
- **unknown**：`webp` 导出的浏览器编码支持与体积；滤镜参数的具体区间（需逐个读 `modules/effects/*` 才能定 schema）；
  `document.new` 清空后原生历史的行为（是否可撤销）未核。
