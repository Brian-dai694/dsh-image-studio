---
name: dsh-media-image
description: Use when editing images inside the DSH image studio (miniPaint editor): reading the shared project, inserting generated or uploaded images, clipping a new layer with a mask, adjusting layer opacity/blend, and exporting. Also use as the controlled editing foundation for Amazon product-image suites. Trigger words: 图片编辑, 编辑器, 图层, 蒙版, 抠图, 生成背景, 换背景, 导出 PNG, Amazon 主图, 亚马逊套图, A+, image studio, media_image.
---

# DSH 图片编辑（受控命令）

## Amazon 商品套图规范入口

用户要求 Amazon 主图/副图/A+ 套图时，先遵循仓库 `docs/amazon-image-suite-standard.md`：确认 Listing/A+ 槽位清单与产品事实；建立 Product Reference Lock；主图先行并审核；副图/A+ 按具体槽位尺寸规划；生成后实测像素比例并只交 canonical 文件。A+ 未指定类型时先确认 Regular/Standard/Premium。云端生成前说明素材上传和费用并取得用户确认；不静默批量生成整套，不把参考资料中的转化百分比当作保证。

规范检查包含目标站点主图白底/主体占比/禁用元素，但实际政策需按站点核实；不能仅凭生成模型声明就标“合规”。产品规格、认证、包装内容缺证据时标 `unknown`，不让模型编造。

## Photoshop COM（结构化 action + 任意 JSX，显式高风险）

本机 desktop profile 可通过 `photoshop.enabled: true` 启用 `media_image_photoshop_action`。默认关闭；Windows Photoshop COM 仅用于操作本机 Photoshop，**不属于当前 miniPaint 工程的同一条历史或 revision**。

- **结构化 action 优先**：`action` 枚举（`status` / `open_image` / `create_document` / `place_image` / `add_text_layer` / `layer_ops` / `adjust_image` / `export_active`）+ 结构化 `arguments`；参数逐个校验，路径必须本机绝对路径且扩展名在白名单内。能用 action 表达的就别写脚本。
- **任意 ExtendScript 也已开放**（本人明确要求）：`media_image_photoshop_run_jsx` 接 `jsx`（1..65536 字节）+ `confirm: true`，脚本原样交给 Photoshop 的 `DoJavaScript`。它**没有沙箱、没有自动回滚**，能读写本机文件、能退出 Photoshop —— AdAdobe 的 ExtendScript 引擎里我们无法把它安全隔离，这一点不要粉饰。仅当结构化 action 表达不了时才用它，并在动手前把脚本读一遍。
- 两者写操作都需要 `confirm: true`。**assist 模式**下还要通过 DSH 原生逐次人工审批（审批前会先读 Photoshop 当前活动文档，把目标文档写进理由）；**autonomous 模式**下按本人授权不再等审批，但回执会带 `autonomous: true` 与"回退要手动"的说明。`status` 是只读。
- **Photoshop 不在 miniPaint 的撤销栈里**：自主模式下它确实会直接执行，但撤销要在 Photoshop 内手动做。所以用它之前先确认目标文档，别把不可回退的操作当试验。
- 超时回执是 **结果未知**（`PHOTOSHOP_RESULT_UNKNOWN`）：不要自动重试，先检查 Photoshop 文档与输出文件。
- 只支持 Windows COM ProgID；不是 Photoshop UI 的截图/鼠标控制；本机未配置/连接 Photoshop 时工具会失败。
- 不要把 Photoshop 操作说成 miniPaint 图层或 revision；两者是不同文档/不同 undo 栈。
- 同一个 `photoshop.enabled` 开关下，`media_image_assistant_photoshop_action` 是共享助手（页面内聊天卡）走同一审批门的内部入口，模型不需要直接调用它。

## 先读后写（硬性）

0. `media_image_list_commands` —— 先拿命令目录：每条命令的 `params`、`needs`、`highRisk`，以及**当前** `enabled` / `disabledReason`（如 `no-selected-layer`、`selected-layer-is-text-not-image`）。它只读、不写画布，用来避免"发一条注定失败的写"。
0b. `media_image_analyze` —— 做完再量一遍：平均亮度、直方图、暗部/高光裁切比例、偏色、清晰度、图层越界/零尺寸/文字超框。返回 `findings[]`，每条带可用的 `suggestedCommand`。**它是只读的**，不会推进 revision；不要凭感觉说"改好了"，用它的数值说话。
   它还返回 `regions[]`：按每个可见图层的外框分别量 `canvasShare`（占画布）/ `opaqueRatio`（该块有内容的像素占比）/ `meanLuma` / `lumaStdDev`，只量面积最大的 24 个（`regionsTruncated` 报还剩几个）。想知道"这个元素在画面上到底显不显"就看这里。
0c. `media_image_preview` —— 拿一张降采样缩略图（data URL，≤256 KB）。只读。**能否真的看到画面取决于宿主是否渲染 tool 结果里的图片**；不能渲染时它只是可保存的缩略图，别声称自己看见了。三个定位手段：
   - `grid:true`（默认 100px）或 `gridStep:8..2000` —— 画坐标网格，标注的是**源图坐标**；
   - `crop:{x,y,width,height}` —— 只截这一块再放大（越界会夹到画布内，回执 `crop` 是**实际用的**矩形）；
   - `layerId` —— 只渲这一层（其他全透明），用来判断"这层到底长什么样 / 是不是被上面压住了"。
   回执带 `crop` / `scale` / `layerId` / `gridStep`，这是把预览上的位置换算回画布坐标的依据。
   `overlayLayerId` 会把该蒙版区域染成半透明色块；`overlaySelection` 染当前选区。
0d. `media_image_recipe` —— 预录流程（对应 PS 的 .atn）：人先审阅一串命令存成带参数的名字（`${param}` 占位），之后任何调用方都能 `action=run` 复用。整串执行仍然是一条历史、失败整体回滚；同样的白名单与高危限制。
1. `media_image_read_state` —— 拿 `projectId` / `revision` / `stateDigest` / 图层表 / `selection` / `assets`。
   每层带 `bounds{x,y,width,height,right,bottom}`、`coverage`（帧∩画布占画布比例）、必要时 `offCanvas`，
   以及 `mask` / `effects` / 文字内容 —— **不要再自己从 `x/y/width/height` 推占位**，也不要猜"会不会压到边"。
2. 用读到的 `revision` 作为 `expectedRevision` 提交 `media_image_apply_command`。
3. 回执里 `revision` 会 +1，`afterDigest` 是真回读出来的摘要。

想一次做多步（比如"加文字 → 调外观 → 改名字"）用 `media_image_run_plan`：传 `steps: [{operation, params}]`（1..12 条），
按顺序执行，**任一步失败会把已执行的步骤撤销**并回报 `rolledBack.undone` 与 `rolledBack.restored`。
高危命令不能进计划，必须用 `media_image_apply_command` 单独确认。

规则：

- 每次写都要**新读一次** revision；拿旧 revision 会被 `REVISION_CONFLICT` 拒绝，这是保护，不是故障。
- 同一个 `commandId` + 同一组参数是幂等的；**不要为了重试换 commandId**。
- 结果若为 `unknown`（超时/网断），**只查不重放**：`media_image_get_command_result` 用原 `commandId`。
- 不要用 `layer.remove` / `canvas.crop` / `layer.add_image` 去"试一下"：assist 模式下它们要人工审批；autonomous 模式下虽然按授权直接执行，但它们会删/裁/引入外部像素，做之前先 `read_state` 确认目标，做完用 `history.undo` 或 `analyze` 核对。

## 可用命令（白名单，超出即拒）

| 场景 | 命令 |
| --- | --- |
| 插文字 | `layer.add_text`（可带 `fontUrl`） |
| 改文字 | `layer.update_text` |
| 插图片 | `layer.add_image`（`sourceRef` 为 `layer:` / `asset:` / 小图 `data:image/...`） |
| 定位尺寸 | `layer.set_frame`、`layer.set_transform` |
| 对槽位 | `layer.align`（`h`/`v` + `margin`，坐标由编辑器算，落点从回执 `detail.aligned` 读，别自己试坐标） |
| 复制/收口 | `layer.duplicate`（做多槽位变体）、`layer.rasterize`（文字/矢量转像素并替换原层）、`layer.merge_down`（与下一层合并，层数减一） |
| 画笔 | `layer.paint_stroke`（点连成线画进该层像素，坐标是图层本地像素，一笔一步撤销） |
| 调色（非破坏） | `layer.set_effect` / `layer.remove_effect`（`params.dshEffects` → 渲染时翻译成 canvas `ctx.filter`，不动像素；`value:null` 删一项，`remove_effect` 省略 `effect` 清空整叠） |
| 蒙版（活蒙版） | `layer.update_mask`（`invert` 反相、`sourceLayerId` 换蒙版源、`remove:true` 整块摘掉；**不收** `mode`/`featherPx`——活蒙版渲染不读它们，要羽化成品就重走 `layer.add_image` + `maskRef` + `featherPx`。成环回 `MASK_CYCLE`） |
| 外观 | `layer.set_appearance`（`opacity` / `blendMode` / `name`） |
| 显隐排序 | `layer.set_visibility`、`layer.reorder` |
| 像素微调 | `layer.feather`、`layer.color_match` |
| 画布 | `canvas.resize`、`canvas.crop` |
| 导出 | `media_image_export_start`：`format:"png"|"jpeg"` 拼平位图；`format:"psd"` 保留图层（文字/矢量已栅格化、活蒙版已烤进像素、超出画布的矩形已夹紧 —— 回执 `approximations[]` 逐条说明降级了什么） |
| 历史 | `history.undo`、`history.redo` |

## 生成 → 落层的正路

`media_image_generate` 只产出素材，**从不自己改画布**：

1. 省略 `prompt` 调用一次，看有哪些 `provider`。
2. `{provider, prompt, width?, height?}` 提交 → `status: pending` + `jobId`。
3. `{jobId}` 轮询 → 成功时 `artifactRef` 是 `asset:<id>`；`unknown` 就再查，不要重新提交。
4. 用 `layer.add_image` 把该 `asset:<id>` 落成图层（这一步才需要 revision；assist 模式下还要人工审批，autonomous 模式按授权直接落层）。

同步直达素材库的还有 HTTP 路由（面板/编排方用，模型没有）：

- `POST /media-image/assets/upload` 二进制上传；`POST /media-image/assets/import {url}` 远程导入。
- `POST /media-image/fonts {url, family}` 登记字体，返回 `/media-image/fonts/<id>` 供 `fontUrl` 使用。

## 蒙版：三种来源

`layer.add_image` 的 `maskRef` 与 `maskRect` **互斥**：

- `maskRef: "layer:<产品层>"` —— 取该层轮廓（`maskMode` 默认 `alpha`），电商换背景的常用姿势。
- `maskRef: "selection:"` —— 取编辑器当前选框，**只在选择工具处于激活状态时有效**（工具切走编辑器会清空选区），没有就返回 `NO_SELECTION`。
- `maskRect: {x,y,width,height}` —— 显式画布矩形，不依赖任何工具状态，需要可复现时用它。

配合 `maskInvert`（反转）与 `featherPx`（0..64 软边）。语义只一条：**只改 alpha，不动 RGB**。

## 边界（不要说成已支持）

- 素材与字体都在插件进程内存里：**重启即失效**，`asset:<id>` 会变 `ASSET_NOT_FOUND`。长期保存用编辑器自己的工程保存/导出。
- 内联 `data:image/...` 上限 256 KB；更大的图走上传或导入。
- 没有任意脚本执行、没有搜索式素材站抓取；字体授权由使用者自负。
- 选择工具的选区状态是"活的"，不要把它当可持久化数据。

## 验收怎么算过

- 写入：回执 `status: applied` 且 `revision` 增加；再读一次 `read_state`，目标图层字段与预期一致。
- 撤销：`history.undo` 后 `read_state` 回到写入前的值（`stateDigest` 与其一致）。
- 导出：`media_image_export_start` 拿 `exportId`，再用 `media_image_export_status` 取 `artifactRef`。
- 生成：作业 `succeeded` 且有 `assetRef`；仅凭 `pending` 不算完成。
