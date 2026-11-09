---
name: dsh-media-image
description: Use when editing images inside the DSH image studio (miniPaint editor): reading the shared project, inserting generated or uploaded images, clipping a new layer with a mask, adjusting layer opacity/blend, and exporting. Trigger words: 图片编辑, 编辑器, 图层, 蒙版, 抠图, 生成背景, 换背景, 导出 PNG, image studio, media_image.
---

# DSH 图片编辑（受控命令）

编辑器是 miniPaint，跑在浏览器里；**人和 Agent 编辑同一份工程，只有一条受控命令通道**。
不要试图写任意脚本、也不要绕过工具直接改文件。

## 先读后写（硬性）

0. `media_image_list_commands` —— 先拿命令目录：每条命令的 `params`、`needs`、`highRisk`，以及**当前** `enabled` / `disabledReason`（如 `no-selected-layer`、`selected-layer-is-text-not-image`）。它只读、不写画布，用来避免"发一条注定失败的写"。
0b. `media_image_analyze` —— 做完再量一遍：平均亮度、直方图、暗部/高光裁切比例、偏色、清晰度、图层越界/零尺寸/文字超框。返回 `findings[]`，每条带可用的 `suggestedCommand`。**它是只读的**，不会推进 revision；不要凭感觉说"改好了"，用它的数值说话。
0c. `media_image_preview` —— 拿一张降采样缩略图（data URL，≤256 KB）。只读。**能否真的看到画面取决于宿主是否渲染 tool 结果里的图片**；不能渲染时它只是可保存的缩略图，别声称自己看见了。
1. `media_image_read_state` —— 拿 `projectId` / `revision` / `stateDigest` / 图层表 / `selection` / `assets`。
2. 用读到的 `revision` 作为 `expectedRevision` 提交 `media_image_apply_command`。
3. 回执里 `revision` 会 +1，`afterDigest` 是真回读出来的摘要。

想一次做多步（比如"加文字 → 调外观 → 改名字"）用 `media_image_run_plan`：传 `steps: [{operation, params}]`（1..12 条），
按顺序执行，**任一步失败会把已执行的步骤撤销**并回报 `rolledBack.undone` 与 `rolledBack.restored`。
高危命令不能进计划，必须用 `media_image_apply_command` 单独确认。

规则：

- 每次写都要**新读一次** revision；拿旧 revision 会被 `REVISION_CONFLICT` 拒绝，这是保护，不是故障。
- 同一个 `commandId` + 同一组参数是幂等的；**不要为了重试换 commandId**。
- 结果若为 `unknown`（超时/网断），**只查不重放**：`media_image_get_command_result` 用原 `commandId`。
- 不要用 `layer.remove` / `canvas.crop` / `layer.add_image` 去"试一下"——它们要人工审批。

## 可用命令（白名单，超出即拒）

| 场景 | 命令 |
| --- | --- |
| 插文字 | `layer.add_text`（可带 `fontUrl`） |
| 改文字 | `layer.update_text` |
| 插图片 | `layer.add_image`（`sourceRef` 为 `layer:` / `asset:` / 小图 `data:image/...`） |
| 定位尺寸 | `layer.set_frame`、`layer.set_transform` |
| 外观 | `layer.set_appearance`（`opacity` / `blendMode` / `name`） |
| 显隐排序 | `layer.set_visibility`、`layer.reorder` |
| 像素微调 | `layer.feather`、`layer.color_match` |
| 画布 | `canvas.resize`、`canvas.crop` |
| 历史 | `history.undo`、`history.redo` |

## 生成 → 落层的正路

`media_image_generate` 只产出素材，**从不自己改画布**：

1. 省略 `prompt` 调用一次，看有哪些 `provider`。
2. `{provider, prompt, width?, height?}` 提交 → `status: pending` + `jobId`。
3. `{jobId}` 轮询 → 成功时 `artifactRef` 是 `asset:<id>`；`unknown` 就再查，不要重新提交。
4. 用 `layer.add_image` 把该 `asset:<id>` 落成图层（这一步才需要审批与 revision）。

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
