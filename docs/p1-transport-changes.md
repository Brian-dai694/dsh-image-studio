# P1 共生交互改动清单（0.2.1，先不动代码）

范围：卡片点击定位高亮（`editor.highlight`）与编辑器选中通知（`editor.selection_changed`）。
前置：0.2.0 真机验收通过后再开工。本文件只列改动，不含实现。

> 现状核对：图片侧**没有** `?debug` 之类的调试钩子。`lib/client.js` 只在 `exports.chat` 里导出内部函数
> 供契约测试使用，宿主只消费 `name / inject / apply`。因此无需收紧，也不存在"面板调试通道"。

## 1. 三条消息（两个方向，不是三个 request）

| 消息 | 方向 | 通道 |
| --- | --- | --- |
| `editor.highlight` | 宿主页 → 编辑器 | 走 `transport.request` 白名单 |
| （highlight 回执） | 编辑器 → 宿主页 | 同一条 request 的 response |
| `editor.selection_changed` | 编辑器 → 宿主页 | 走 port 主动推送，**不进 request 白名单** |

## 2. 逐文件改动（含现成行号）

1. `plugin/dsh-media-image/public/host/iframe-transport.mjs:82`
   白名单数组加一项 `'editor.highlight'`。**只加这一个**；`selection_changed` 不进白名单（它是推送帧，
   由 `iframe-transport` 的接收逻辑分派给订阅回调，不经过 `waitFor`）。
2. `miniPaint/src/js/dsh-editor-bridge.js:335-339`（`handleRequest` 的 type 分派）
   加 `if (request.type === 'editor.highlight') return this.highlight(request)`，其余不动。
3. `miniPaint/src/js/dsh-highlight.js`（**新增**）
   一层独立的 overlay canvas（`position:fixed;pointer-events:none`），只为高亮画描边；
   坐标来自 `layer.x/y/width/height` 与 `zoomView.getPosition()/getScale()`，每帧与 resize 时同步。
   **不得读写 `config.layers`、`config.layer`、`app.State`**——这是"只改描边"的落地方式。
4. `plugin/dsh-media-image/scripts/image-page/host.js:76-108`
   现有 `window.addEventListener('message')` 里加一个分支，与 `media.export.download`（:80-98）同形：
   `media.highlight.request` → `transport.request({type:'editor.highlight',...})` → 回 `media.highlight.result`。
5. `plugin/dsh-media-image/lib/client.js`（渲染层已就绪，只接线）
   `renderRow` 已按计划里的 `locate` 决定卡片可不可点；这里只需接 `props.onLocate` →
   `postMessage({type:'media.highlight.request', requestId, objectIds, kind})`，2 秒超时。
6. 测试：`miniPaint/bridge.test.cjs`、`plugin/dsh-media-image/test/{client,image-contract}.test.mjs`。

## 3. 字段与语义

```js
// 请求
{ type: 'editor.highlight', requestId, editorInstanceId,
  objectIds: string[1..200],            // 图片侧是 layerId
  ttlMs?: 200..5000 }                   // 默认 2000
// 成功回执
{ ok: true, matched: string[], missing: string[] }
// 失败回执（统一形状，不许静默）
{ ok: false, error: { code, message, requestId } }
// code: INVALID_REQUEST | HIGHLIGHT_UNSUPPORTED | EDITOR_NOT_READY | EDITOR_INSTANCE_MISMATCH
```

**硬约束（三条，违反即缺陷）**：不改 `selection`、不 bump `revision`、不进历史。
TTL 到期自动消退；重复高亮同一对象只刷新 TTL；不写入工程、不持久化。

```js
// 选中通知（推送）
{ type: 'editor.selection_changed', editorInstanceId, revision,
  selectedObjectIds: string[], objectKind: 'layer' | null, at: number }
```

节流 ≥100ms（尾沿），`revision` 只用于让宿主页面判断"是否还是同一份状态"，**宿主不得缓存成第二份文档状态**。

## 4. 超时与失败

| 项 | 值 | 理由 |
| --- | --- | --- |
| highlight 请求超时 | **2000ms** | UI 操作，慢于 2 秒就等于没反应；超时明确报错，不重试 |
| 默认 TTL | **2000ms**，clamp 200–5000 | 与架构师"自动消退"要求一致 |
| 选中通知节流 | **≥100ms** | 拖动选择时避免刷屏 |
| 失败回执 | `{ok:false,error:{code,message,requestId}}` | 渲染层把 code 映射成中文，不显示原始 JSON |

## 5. 要补的断言（6 条）

1. `highlight` 前后 `revision` 与 `contentDigest` **都不变**，`State.action_history.length` 不变；
2. `highlight` 前后 `config.layer.id`（选中）**不变**；
3. 不存在的 layerId → `missing` 里列出，`matched` 为空，**不抛异常**；
4. TTL 到期后 overlay 元素被移除（假时钟推进，不用 sleep）；
5. `selection_changed` 在 100ms 内多次触发只发 1 条，且 payload 的 `selectedObjectIds` 与编辑器一致；
6. 白名单测试：`editor.highlight` 放行、`editor.highlight_result` 这类编造类型仍被拒（不新增可写通道）。

## 6. 风险与回退

- **缩放/拖动画布时 overlay 错位**：overlay 每帧按 `zoomView` 重算；不能只算一次。
- **高亮期间图层被移动**：用户拖拽是原生行为，overlay 需在原生动作提交后刷新（跟随即可，不改文档）。
- **回退**：白名单删掉那一行 + 宿主页忽略 `media.highlight.request` 即可；`locate` 已在 `dialog-model@3` 的计划形状里，不需要数据迁移。
- **不允许**为了高亮去改 `config.layers`/`State`——那是"点一下卡片就改了文档"，比不做更糟。

## 7. 明确不做

不做面板直连命令、不做高亮改选中、不做高亮持久化、不做 `selection_changed` 的服务端存储、
不做按模型自由生成建议（建议表仍是静态白名单，白名单外不显示而不是置灰）。
