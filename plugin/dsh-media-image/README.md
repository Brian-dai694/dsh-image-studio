# dsh-media-image

DSH Host plugin: shared image editing tools plus the packaged miniPaint page.

独立包：只注册图片入口（`dsh-media-image`），路由前缀 `/media-image`，
工具表只含 `media_image_*`。与另一个编辑器包互不依赖，可单独安装。

## 原生面板开关与授权

原生「图片编辑器」面板默认隐藏（桌面浮层助手仍保留）。隐藏会同时移除面板里的“本人授权工程”入口：

- 尚未授权工程的会话，图片编辑工具会返回 `SESSION_BINDING_REQUIRED`。浮层助手仍可对话、生成、导入，但模型工具不会修改画布。
- 恢复入口：在浏览器控制台执行 `globalThis.__DSH_MEDIA_IMAGE_PANEL__ = true` 并重新加载页面；回到 DSH 侧栏「图片编辑器」，由本人绑定并授权工程。重新启动应用后恢复默认隐藏。
- 已有授权是否有效取决于 Host 侧会话与授权票据；如需重新授权，必须由本人操作，Agent 不代点。
- 原生工具卡片仍注册，宿主会话里的工具回执不受面板隐藏影响。

此开关只控制客户端侧栏入口与 main 面板，不隐藏悬浮宿主页。

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
