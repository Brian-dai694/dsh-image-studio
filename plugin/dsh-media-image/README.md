# dsh-media-image

DSH Host plugin: shared image editing tools plus the packaged miniPaint page.

独立包：只注册图片入口（`dsh-media-image`），路由前缀 `/media-image`，
工具表只含 `media_image_*`。与另一个编辑器包互不依赖，可单独安装。

## 原生面板

DSH 侧栏「图片编辑器」和画布主面板保持显示。截图红框里的原生 Conversation 默认隐藏，页面右下角悬浮助手保留。隐藏的只是对话子组件，不会移除侧栏插件入口、画布或本人授权入口。若要恢复红框对话，可设置 `globalThis.__DSH_MEDIA_IMAGE_CONVERSATION__ = true` 或 `localStorage.setItem('dsh-media-image-conversation', 'visible')` 并刷新；设为 `false` / `'hidden'` 可再次隐藏。旧开关 `__DSH_MEDIA_IMAGE_PANEL__` 不再控制插件侧栏，避免把整个插件误藏。


## 套版（PSD → 画布）

选一个 `.psd` 后，页面**先给预览**再动手：

- 列出可选商品槽 `#1..#n`（按面积排序，整幅背景槽排除在外）及各自占画布比例；
- 列出将沿用的 PSD 文案；
- 说明装饰图层（渐变/描边/投影）不会被还原。

说完「套版」按默认 `#1` 执行；要换槽就说「套版：2」。规划器 `planTemplateApply` 同时返回 `candidates`（候选槽）、`mapping`（逐槽结论：`place-product` / `replaced-by-solid-background` / `skip` / `place-text`）与 `skipped`，页面和测试都据此核对，不靠猜。指定整幅背景槽会以 `TEMPLATE_SLOT_NOT_FOUND` 拒绝。

执行是**合成式**（0.17 起）：`canvas.resize` → 逐层合成底图 → 商品图 → 文字，每条命令单独确认，可撤销。

底图由 `lib/psd-composite.js` 生成：解析 PSD 各图层的像素通道（支持 raw/RLE 压缩），**排除文字层与选定的商品槽**，把其余可见图层按位置、alpha 与**混合模式**合成为一张整幅 PNG。

已实现的混合模式：`norm` 正常、`mul` 正片叠底、`scrn` 滤色、`over` 叠加、`dark` 变暗、`lite` 变亮、`diff` 差值、`smud` 柔光、`hLit` 强光（按 W3C 分离通道公式）。**未实现的模式不猜**：退回正常模式并记进 `approximated`，页面会提示「N 处近似还原」。
图层不透明度与**图层蒙版**（alpha 通道 -2）都会乘进该层的 alpha。
**剪贴蒙版**（clipping 位）会把该层 alpha 乘上它下方底图层在同像素的 alpha。
**调整图层**支持 `brit`（亮度/对比度），按近似公式作用在已合成像素上并登记 `ADJUSTMENT_BRIGHTNESS_APPROXIMATED`。
**图层效果**支持描边与投影（解析 `lmfx`/`lfx2` 的 Descriptor）：

| 效果 | 支持的字段 | 渲染方式 |
|---|---|---|
| 描边 `FrFX` | 颜色、尺寸、不透明度、位置（外/内/居中） | alpha 膨胀减法，外描边画在层上 |
| 投影 `DrSh` | 颜色、不透明度、角度、距离、模糊 | alpha 平移 + box blur，画在层下 |

投影角度按 PS 约定（角度是**光照方向**，阴影落在反方向：`angle+180°`）。
渲染是近似：颜色/抗锯齿与 PS 不完全一致，因此都会登记 `LAYER_EFFECT_*_APPROXIMATED`；
描述符解析失败时登记 `LAYER_EFFECTS_UNPARSED` 并**照常合成图层本体**，不会毁掉整张底图。因此 PSD 的渐变、描边、投影会真的出现在画布上，而不是被丢弃。单层解码失败只跳过该层并记录，不毁掉整张底图；整体不可解（CMYK、非 8bit、ZIP 压缩）时退回纯色背景，并在页面说明原因（`baseError`）。

`POST /media-image/template/apply` 一次上传完成「解析 → 合成 → 规划」，请求头为 `x-psd-product-asset`（商品素材）、`x-psd-slot`（可选商品槽）、`x-psd-background`（降级背景色）、`x-psd-texts`（可选文案 JSON）。

已知边界：混合模式目前统一按 source-over 合成，特殊混合模式（如 multiply）会有色差；图层蒙版、剪贴蒙版、调整图层没有还原。

## 批量套版

同一个模板、同一个商品槽，换多个商品图各出一份成品：

- `POST /media-image/template/batch`：一次上传 PSD，底图只合成一次（`assets` 里只有一份底图），返回 `variants[]`，每份是独立的 `plan`（`x-psd-products` 传 JSON 数组，1..20 个）。
- 页面对已上传的每张商品素材各出一份：写入画布 → `editor.export_start` 导出 PNG → 上传入素材库 → 撤销回原状。整批只弹一次确认（确认文案写明会逐份写入并导出）。
- 撤销策略：第一步用 `targetCommandId`/`afterDigest` 精确撤销证明栈顶就是刚写的命令；桥接在 undo 后会清掉这份凭据，后续走普通撤销。每份结束都用 `contentDigest` 与批量前比对，不一致就停止并如实报告，不假装恢复成功。
- 中途失败：撤销已应用步骤、停止批量、报告已完成份数，画布留在可检查的已知状态。

已知边界：批量固定使用同一商品槽与同一套文案（每份可用 `texts` 覆盖）；不同槽位的批量尚未支持。

## 本地重绘后端（`kind: command`）

`scripts/inpaint-local.py` 是随包分发的本机填充脚本：**扩散填充（Telea 类松弛）+ 边界羽化**，只用 numpy + Pillow。

- 适合：去小物体、去文字、补瑕疵，背景平整或带纹理都行
- **不适合**：凭空生成新主体——它不是神经模型，别把它当 AI 重绘
- 契约：`--image IN.png --mask MASK.png --out OUT.png`，蒙版白色=要补；空蒙版明确失败
- 接入：profile 里 `generation.providers` 配 `kind: command` + `args` 占位符 `{image}/{mask}/{output}`

配置示例（profile `cordis.patch.yml`）：

```yaml
- id: dsh-media-image
  name: dsh-media-image
  config:
    dataDir: C:/Users/UEFR/.dsh/profiles/desktop/data/dsh-media-image
    generation:
      maxConcurrency: 2
      providers:
        - id: local-diffusion
          kind: command
          command: <本机 python 绝对路径>
          args: [<包内>/scripts/inpaint-local.py, --image, "{image}", --mask, "{mask}", --out, "{output}"]
          timeoutMs: 120000
```

## 素材持久化

`config.dataDir` 现在真的被用了：素材写到 `<dataDir>/assets/`（`blobs/<id>` + `assets.json` 索引），重启后 `asset:<id>` 引用仍然可用。

- 没配 `dataDir` 时行为不变：纯内存、重启即失效（临时语义）
- 字节默认**懒读**，内存只留最近 8 个，避免启动时把几百 MB 一次读进来
- 索引坏行会被跳过并计数，不让插件起不来；上限（128 个 / 256 MB）依旧生效
- `clear()` 只清内存缓存，**不删用户文件**；只有测试/运维用的 `purge()` 才真删
- 写盘失败不让上传失败：退回内存态并把该素材标记为未持久化

## 活蒙版（可接管）

`layer.add_image {maskRef:"layer:<蒙版层id>"}` 现在绑定的是**活蒙版**：蒙版记在 `params.dshMask`，由合成阶段按蒙版层 alpha 逐像素相乘。

- `read_state` 会报 `mask: {sourceLayerId, editable: true}`
- **改蒙版层 → 结果跟着变**（不是把蒙版烤进像素）
- 蒙版层本身不会被当成画面内容画出来（它只是数据）
- 隐藏蒙版层 = 取消遮罩；`invert:true` 取反
- 其它来源（`selection:` / `asset:` / `data:` / `maskRect`）没有可编辑对象，仍直接烤进像素

## 助手指令与高频操作

面板对话框支持同义说法（`去掉背景`→抠图、`回退`→撤销、`保存成png`→导出），未命中时给出可点建议而不是只说"没听懂"。

本地直达的高频操作：

| 说法 | 动作 |
|---|---|
| `撤销` / `重做` | `history.undo` / `history.redo`（无凭据的普通撤销） |
| `删除这层` | 弹确认后 `layer.remove`（高危，可再撤销） |
| `透明度 60%` | `layer.set_appearance {opacity}`（需选中图层） |
| `导出PNG` | `editor.export_start` → 浏览器下载，不改画布 |

## 预览与自检

`media_image_analyze`（只读，不推进 revision）在**降采样**合成图上测量：

| 项 | 内容 |
|---|---|
| 曝光 | 平均亮度、8 桶直方图 |
| 裁切 | 暗部（≤4）与高光（≥251）像素占比 |
| 偏色 | R/G/B 均值与差值 |
| 清晰度 | Laplacian 方差（降采样后算） |
| 图层体检 | 越界、零尺寸、文字层估计宽度超框、文字与背景对比不足、位图被放大 |

`layer.update_text` 支持 `style:{fill_color}`，所以"文字与背景对比不足"有可执行的修复命令（`TEXT_LOW_CONTRAST` → `layer.update_text`），而不是只报警。
`media_image_preview` 支持 `grid:true`：在缩略图上画 100px 坐标网格并标注源图像素坐标，方便把"位置"对上数字。

返回 `analysis` + `findings[]`，每条 finding 带 `suggestedCommand`（**必须是白名单命令**，测试逐条核对）。
助手执行完 plan / 套版后会自动跑一次，回一句 `计划自检：平均亮度 0.46 · 高光裁切 0.0%`，只报数值不做主观评价；
测不出来就什么都不说，不编数字。

确认卡片也改了：`{"layerId":"3"}` 会被翻译成 `商品图 · image · 120,80 320×240`，失效 id 显示 `(图层已不存在)`。

`media_image_preview`（只读）返回降采样 PNG data URL（长边 64..1024，默认 640，**≤256 KB**，超了报 `PREVIEW_TOO_LARGE` 而不是截断）。
诚实边界：能否"看见"取决于宿主是否渲染 tool 结果里的图片；不渲染时它只是可保存的缩略图。

重绘输入的蒙版也改了：选区路径现在按**选区较长边 1/8** 做外缘渐隐（不是硬边），模型更容易把主体画在选区内、接缝更少。

## 批量执行与单步撤销

`history.batch {steps:[{type,payload}], name?}` 把 1..12 条命令合成**编辑器里的一条历史记录**（miniPaint 的 `Bundle_action`）：

- 任一步失败，`Bundle_action` 会先把已执行的步骤撤销再抛错——**整体回滚**，不留半步
- 撤销栈只增加一条，Ctrl+Z 一次就整串撤销
- 里面不能嵌套 `history.*`，也不能包含高危命令（`layer.remove` / `canvas.crop` / `layer.add_image`），它们必须单独走审批

`media_image_run_plan` 与助手侧的 `{"type":"plan","steps":[…]}` 都走这条命令，所以"一次确认、一次写入、一步撤销"是同一个实现。

## 命令目录（给调用方的前置知识）

`media_image_list_commands` 只读、不写画布，返回每条白名单命令的：

| 字段 | 含义 |
|---|---|
| `id` / `params` | 命令名与参数契约（与 `bridge.js` 白名单同源，测试逐条核对不漂移） |
| `needs` | 前提：`none` / `layer` / `text` / `image` / `history` |
| `highRisk` | 是否需要人工审批（`layer.remove` / `canvas.crop` / `layer.add_image`） |
| `enabled` / `disabledReason` | 现在能不能用；不能时的原因如 `no-document`、`no-selected-layer`、`selected-layer-is-text-not-image` |

编辑器读不到时 `enabled` 一律是 `null` 并附 `stateUnavailable`——如实说"不知道"，不假装可用。
配合它还有一处改进：把命令名写错时（`UNSUPPORTED_COMMAND`），错误里会带最多 3 个近似名与 `media_image_list_commands` 的指引，不再只回一句"不在白名单里"。

## 文字先量再画

套版放置文字前会先用 `editor.measure_text` 量一次（不绘制、不推进 revision），把字号二分收缩到槽宽内；缩到 8px 仍放不下时如实报告，不静默溢出。回执会写「文字按槽宽收缩：40→22px」，排版失败也会列出来。

`editor.measure_text` 契约：入参 `{text, style:{size,family,bold,italic}, maxWidth?}`，返回 `{width, height, lineCount, lineHeight, size, fittedSize, maxWidth, fits}`；给 `maxWidth` 时 `fittedSize` 是能放进该宽度的最大字号。

## 写入熔断

同一个 `operation + params` 连续失败两次后，第三次直接返回 `REPEATED_FAILURE`（`retryable: false`），要求改参数或先读 `read_state` 查前提；成功一次即清零。避免模型在同一个错误上反复重试。

## 中继请求类型

页面能发的每种 `editor.*` 请求都必须登记在 `lib/index.js` 的 `EDITOR_REQUEST_TYPES`，否则 relay 会在运行时直接拒成 `INVALID_REQUEST`。`test/guards.test.mjs` 会从页面与桥接源码里反查实际用到的类型并逐一核对——0.20.0 就是靠它发现 `editor.export_inpaint_inputs`（局部重绘导出）和 `editor.highlight`（面板定位高亮）两条漏登记。

## 局部重绘（ComfyUI inpaint workflow）

局部重绘只对**显式声明**支持 image+mask 输入的后端开放。普通 text-to-image workflow（包括桌面 profile 当前的 `mock-comfy`）不支持局部重绘；助手会在提交前拒绝，不会把整图生图冒充 inpaint。

### 方式一：本地命令行后端（不用架服务）

适配器 `kind: "command"` 会写两张临时 PNG 再执行操作者配置的命令，读回 `{output}` 的 PNG：

```yaml
generation:
  providers:
    - id: local-inpaint
      kind: command
      command: python            # 绝对路径更稳
      args: ["C:/models/inpaint.py", "--image", "{image}", "--mask", "{mask}", "--out", "{output}"]
      outputName: out.png        # 默认 out.png
      timeoutMs: 180000
```

占位符：`{image}` `{mask}` `{output}` `{prompt}` `{width}` `{height}`。**不经过 shell**，所以路径里的空格和引号不会变成注入；命令本身是操作者写的，插件不内置也不下载任何模型。蒙版是白=要重画、黑=保留的 PNG，与源图同尺寸。

失败有稳定码：`INPAINT_COMMAND_FAILED`（退出码非 0）、`INPAINT_TIMEOUT`、`INPAINT_OUTPUT_MISSING`（没写文件）、`INPAINT_OUTPUT_INVALID`（不是 PNG / 超过 64 MiB）。这类后端只提供局部重绘能力（`capabilities.inpaint=true`、`textToImage=false`），不会被文生图请求误用。

### 方式二：ComfyUI inpaint workflow

在对应 provider 配置中增加 `editImageNode`、`editMaskNode`（均为 `{ nodeId, field? }`，默认 field=`image`），并确保 API workflow 确实将图像节点接到 inpaint/latent noise mask 输入：

```yaml
generation:
  providers:
    - id: comfy-inpaint
      kind: comfyui
      baseUrl: http://127.0.0.1:8188
      workflow: # ComfyUI API-format inpaint workflow
        # ...真实 workflow 节点...
      promptNode: { nodeId: "6", field: text }
      editImageNode: { nodeId: "20", field: image }
      editMaskNode: { nodeId: "21", field: image }
```

节点 ID 必须来自你实际 ComfyUI workflow；插件只把源图和蒙版上传到该配置的 ComfyUI，再按这两个节点 ID 注入文件名，不会猜 workflow。页面要求选中带源图绑定的蒙版层，或选中图片层并保留有效选区。结果先回到临时素材库，再经用户确认成为带同一蒙版的新图层；原图不改。

配置虽然存在并不自动证明 workflow 做了正确的局部采样：需用实际 ComfyUI inpaint workflow 做端到端测试，确认蒙版外像素保持不变。

## 局部重绘

阶段 2 提供源图+选区/绑定蒙版 → 显式支持 inpaint 的 ComfyUI API workflow → 新素材 → 用户确认后独立结果层。ComfyUI provider 必须配置 `editImageNode` 与 `editMaskNode`，并确认 workflow 确实将 mask 接到局部采样节点；插件将源图、蒙版通过同源鉴权上传到该 ComfyUI，Host Relay 不传像素数据。执行前会再读 document/revision；结果未知只可查原 job，不重提。结果落层前二次读状态，原图和蒙版不覆盖。

**当前桌面 profile 仅有 `mock-comfy` 文本生图 workflow，未配置 edit image/mask 节点，不能真实局部重绘。** 页面 capability 会拒绝提交并告知配置要求；测试模拟 Provider 只验证协议，不代表真实 AI 输出。配置真实 ComfyUI inpaint workflow 后，仍需用真实后端做端到端验证。

## 可修正蒙版闭环

本地「抠图」创建独立蒙版层并合成结果副本，原图不改。蒙版绑定存储在图层 `params.dshMask.sourceLayerId`，`read_state.layers[].mask` 可读取源图关系。选择蒙版层并用画笔/橡皮修正后，说「合成蒙版」会读取当前像素新增结果副本。多张蒙版必须先选中一张；源图已删除时拒绝合成；确认期间 revision 改变时停止。每次合成是快照，不会随蒙版实时更新。蒙版是普通 alpha 图层，并非原生实时图层蒙版。颜色法不能保证复杂背景抠图质量。

## 抠图服务（需配置真实引擎）

助手支持“抠图 / 去背景”指令，但**本插件不自带分割模型**。必须在 Host plugin config 中配置一个受信任的 rembg 兼容 endpoint：`backgroundRemoval: { endpoint: "http://127.0.0.1:5000/api/remove", apiKey: "…" }`。服务需接受 multipart 字段 `image_file`，成功返回带 alpha 的 PNG。插件会校验返回 PNG 的透明通道并保存为新 `asset:<id>`；原图不修改，结果也不会自动落画布，用户说“插入图层”后仍要确认。未配置时助手明确提示缺少后端，`GET /media-image/background-removal` 返回 `available:false` 与配置提示。

该 endpoint 由操作者配置，插件对其发送用户素材；不要配置不受信任的第三方服务。`apiKey` 仅 Host 内存使用，不回传浏览器。

## 随包技能

`skills/dsh-media-image/SKILL.md` 是给 Agent 的操作规范（先读后写、白名单命令、蒙版三来源、
生成→落层正路、边界与验收口径）。`cordis.patch.yml` 里用 `@deepseek-ai/dsh-skill-filesystem`
把本包 `skills/` 挂成技能源，`providerName: dsh-media-image` 独占，不与内置 `runtime` 或其他插件抢名。

`test/plugin-conventions.test.mjs` 会交叉校验：SKILL.md 里点名的命令必须在 `ALLOWED_COMMANDS.image` 里、
点名的工具必须是已注册工具，且**每个已注册工具都必须在文档里出现**——防止新工具上线后文档默默落后。

## 素材上传（大图回流）

编辑器支持把**生成结果或本地大图**作为新图层插入当前工程，绕过 relay 的消息体上限：

| 步骤 | 入口 | 说明 |
| --- | --- | --- |
| 1. 上传 | `POST /media-image/assets/upload`（同源 + `Bearer` 启动令牌 + `x-dsh-media-asset: 1`） | 请求体是原始图片字节；返回 `{ asset, sourceRef: "asset:<id>" }` |
| 2. 插入 | `media_image_apply_command`，`operation=layer.add_image`，`params.sourceRef="asset:<id>"` | 走既有高风险审批、`expectedRevision` 与撤销；像素不进模型上下文 |
| 3. 回读 | `media_image_read_state` 的 `assets` | 只有 `id/name/mime/bytes/createdAt` 元数据 |

页面入口在宿主页「临时素材」面板：选择文件 → 上传 → 复制 `asset:<id>`。
模型侧没有上传工具——图像字节不应进入模型上下文，上传只能由本人在同源页面发起。

### 边界（不要当成持久化存储）

- 单张上限 **32 MiB**，暂存总量 **256 MiB**、最多 **128 个**；超出分别返回 `PAYLOAD_TOO_LARGE` / `ASSET_STORE_FULL`。
- 只接受按**文件签名**判定为 PNG / JPEG / WebP 的内容；改扩展名或伪造 `Content-Type` 会被 `UNSUPPORTED_IMAGE_TYPE` 拒绝。
- 素材存在插件进程内存里：插件卸载、进程重启即失效，`asset:<id>` 随之返回 `ASSET_NOT_FOUND`（编辑器侧 `ASSET_FETCH_FAILED` 表示读取失败）。
- 素材不写磁盘、不进导出产物；需要长期保存请用编辑器自身的工程保存/导出。
- `data:image/...` 内联形态仍保留，解码上限 256 KB，仅适合小图与预览。

## 图层外观（合成控制）

```json
{"operation":"layer.set_appearance","params":{"layerId":"<id>","opacity":40,"blendMode":"multiply","name":"背景·正片叠底"}}
```

- `opacity` 0–100；`blendMode` 取浏览器 `globalCompositeOperation` 全集（`source-over`/`multiply`/`screen`/`overlay`/`darken`/`lighten`/`color-dodge`/`soft-light`/`hue`/`saturation`/`color`/`luminosity` 等 26 个）；`name` 1–120 字符。
- 三项至少给一项，一个都不给直接拒绝；`opacity`/`blendMode`/`name` 都会出现在 `read_state` 里，便于模型改完自检。
- `blendMode` 已纳入内容摘要（`documentState`/`metadataState` 的 `composition`），所以"写后回读校验"对它同样成立，不是只看元数据。
- 一次写入 = 一条原生历史，撤销整步回退。

复制一个图层不需要新命令：用 `layer.add_image` + `sourceRef: "layer:<id>"` 即可（像素复制、独立历史）。

## 蒙版挖洞（局部 AI 编辑）

`layer.add_image` 支持"插入时就带蒙版"，目标是**不动既有图层**：生成图按产品轮廓挖空后作为新图层叠上去。

```json
{
  "operation": "layer.add_image",
  "params": {
    "sourceRef": "asset:<生成的背景 id>",
    "maskRef": "layer:<产品层 id>",
    "maskMode": "alpha",
    "maskInvert": false,
    "featherPx": 2,
    "name": "生成背景"
  }
}
```

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `maskRef` | `layer:<id>` / `asset:<48 位 id>` / `data:image/...` / `selection:` | 蒙版来源；`selection:` 用编辑器当前选框 |
| `maskRect` | `{x,y,width,height}` | 显式画布矩形，不依赖任何工具状态；与 `maskRef` 互斥 |
| `maskMode` | `luminance`（asset 默认）/ `alpha`（layer、selection、rect 默认） | 灰度图按亮度取覆盖；图层按自身 alpha 取轮廓 |
| `maskInvert` | 布尔，默认 false | 反转覆盖：`maskRef=layer:<产品>` 时产品处挖空、其余保留 |
| `featherPx` | 0–64，默认 0 | 软化蒙版边缘，避免锯齿 |

选区说明：`read_state.selection` 回显当前选框 `{x,y,width,height}`（无选区为 `null`）。只在**选择工具处于激活状态**时可信——该工具切走时编辑器会清空选区（`config.TOOLS` 里 `selection` 配了 `on_leave`），此时 `maskRef: "selection:"` 返回 `NO_SELECTION` 而不是悄悄画成全图。需要稳定复现时用 `maskRect`。

语义只有一条：**只改 alpha，不动 RGB**。ImageData 是非预乘的，按覆盖率缩 RGB 会让半透明边缘发暗，而挖洞要的是"同样的颜色、不同的覆盖面"。

约束：

- 不给 `maskRef` 时，`maskMode`/`maskInvert`/`featherPx` 一律拒绝，避免"以为生效、实际被忽略"。
- 蒙版会被缩放到源图尺寸；像素运算在 `dsh-pixel-ops.applyMask`，纯函数、可 Node 单测。
- 仍是高风险写操作，走既有原生/面板审批；撤销是一次原生历史步。
- 无蒙版时透传原始 `dataUrl`；只有真改了像素才重编码。

## 生成后端接口（ComfyUI / 云端）

留好的接口：Host 侧提交作业、轮询、取字节，成功后**直接进素材库**并返回 `asset:<id>`，
后续复用 `layer.add_image`（含 maskRef/maskRect 蒙版）落到画布——生成结果与手工上传走同一条回流路径。

```text
POST /media-image/generate        {provider, prompt, width?, height?, extra?, idempotencyKey?}  → 202 {job}
GET  /media-image/generate        → {providers:[{id,kind,baseUrl,hasApiKey}]}
GET  /media-image/generate/<job>  → {job:{status, assetRef?, error?}}
```

同源 + `Authorization: Bearer <启动令牌>`；未配置任何后端时一律 `501 PROVIDER_UNAVAILABLE`，不会假装能生成。

作业状态：`queued → running → succeeded | failed | unknown`。
**轮询阶段的任何传输错误记为 `unknown`，不是 `failed`**——保留 remoteId，再查一次可恢复；只有后端明确回错才是 `failed`。

### 配置

优先级：插件配置 `generation.providers` > 环境变量 `DSH_MEDIA_IMAGE_PROVIDERS`（JSON 数组）。

```jsonc
// 本地 ComfyUI：workflow 用 ComfyUI「API 格式」导出的 JSON，提示词注入点显式给出，不猜结构
{ "id": "local", "kind": "comfyui", "baseUrl": "http://127.0.0.1:8188",
  "workflow": { /* API 格式图 */ }, "promptNode": { "nodeId": "6", "field": "text" },
  "widthNode": { "nodeId": "5", "field": "width" } }

// 云端：同步出图（image_base64 / image_url）或异步（job_id）都支持
{ "id": "cloud", "kind": "http-json", "baseUrl": "https://api.example.com",
  "submitPath": "/generate", "pollPath": "/jobs/{jobId}", "apiKey": "<从环境变量注入>" }
```

`apiKey` 只用于请求头，**不出现在任何返回结构或日志里**（测试已断言）。配置写坏只会禁用生成能力并打一行警告，不影响插件其余功能。

**未验证**：本机没有 ComfyUI 也没有云端凭据，以上协议只按各自公开接口形态实现，用假后端验证了本插件这一侧；
真实后端能否跑通尚未验证。

## 联网素材与字体（受控路径）

只有一条出站路径，全部经过 `lib/remote.js` 的守卫：**只允许 http/https、默认拦内网与回环地址、
限字节数、跳转逐跳复核**（不能靠 `redirect: follow` 蒙过 allowlist）。内容类型不信任响应头，
一律按文件签名判定，伪装扩展名会被拒。

```text
POST /media-image/assets/import   {url, name?}            → 201 {asset, sourceRef:"asset:<id>"}
POST /media-image/fonts           {url, family}           → 201 {font:{id,family,url}}
GET  /media-image/fonts           → {fonts:[...]}
GET  /media-image/fonts/<id>      → 字体字节（Bearer + x-dsh-media-asset）
```

**这不是搜索引擎**：URL 由你提供，插件不抓素材站、不内置字体。字体是受版权/许可约束的资产，
用哪个文件、授权是否成立由使用者负责；插件只做"验明正身 + 限量暂存 + 同源供字节"。

编辑器侧字体：`layer.add_text` / `layer.update_text` 可带 `fontUrl`（必须是 `/media-image/fonts/<48 位 id>`，
且需要 `style.family` 指定字体族）。编辑器用**带令牌的 fetch** 取字节转 blob URL 再 `FontFace`——
CSS 的 `@font-face` 请求不带自定义头，直接给需要鉴权的 URL 会 403。

| 限额 | 值 |
| --- | --- |
| 素材：单张 / 总量 / 个数 | 32 MiB / 256 MiB / 128 |
| 字体：单个 / 总量 / 个数 | 8 MiB / 64 MiB / 32 |

字体与素材都只在进程内存里，重启即失效。

## 测试

```bash
node --test test/*.test.mjs
```

编辑器侧 `miniPaint/bridge.test.cjs` 覆盖 `asset:<id>` 的令牌握手、字节拉取与落层撤销。
