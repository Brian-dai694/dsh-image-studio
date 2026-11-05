# 对话面板映射与共生交互规范 v1（0.2.0 方向）

> 状态：设计与契约草案，**未实现**。适用于两个仓库：
> `dsh-image-studio`（主）与 `dsh-video-studio`（同构，字段名不同）。
> 写作时只读代码，未修改任何实现。

## 0. 结论摘要

- **面板能拿到的东西比想象中多，但缺三样**：编辑器侧的"当前选中"推送、工具卡片到画布的定位通道、审批的提交权。
- **审批提交权拿不到，也不该绕**：官方审批只能由原生 UI 在进程内 resolve，第三方面板只能"看状态 + 打开原生会话"。面板**不得**出现伪造的「允许」按钮。
- **共生三条里，两条现在就能做**（撤销凭据、卡片→定位），一条需要新增一条 iframe 消息（选中推送）。
- **深色模式本期不做**，理由见 §4.5。

---

## 1. 对话面板映射规范

### 1.1 事件来源：我们现在实际订阅的是什么

面板用 `remote.session.follow({ address:{kind:'session', sessionId}, assistantStream:true, maxMessages:200 })`
订阅专属会话（`lib/client.js:87-93`），把事件折叠成行（`client.js:301-328`）。当前**已消费**的类型：

| 事件 | 已用字段 | 用途 | 现状 |
|---|---|---|---|
| `user/message` | `data.source.kind === 'user'`、`surfaceOp`、`message` 文本 | 只把**真人**消息当聊天（`:306`），过滤掉运行时与技能目录注入 | ✅ 已过滤 |
| `assistant/message` | `message` 文本 | 助手整段回复 | ✅ |
| `assistant-stream` | `attemptId`、`revision`、`chunk.type==='text-delta'`、`outcome.kind/seq` | 流式增量；`abandoned` 丢弃（`:290-300`） | ✅ |
| `approval/asked` | `toolName`、`reason` | 审批进行中 | ✅ |
| `approval/decided` | `outcome` | `allowed-once/rejected/cancelled/unavailable` 四态文案（`:235-241`） | ✅ |
| `tool/call` | `toolName`、`arguments` | 工具卡片（running） | ✅ |
| `tool/result` | `result/value`、`status`、`revision`、`error.code`、`exportId/artifactRef` | 结果卡片、导出证据、撤销凭据 | ✅ |

**拿不到 / 不要指望的**：

| 想要 | 现实 | 处理 |
|---|---|---|
| 审批的**提交入口** | 无 Remotes 方法；官方 UI 在进程内 `resolve`（见 §2） | 只读展示 + 打开原生会话 |
| 本地化的 `displayReason` | 只用于呈现，**不写审计事件**（`dsh-user-approval/lib/types/types.d.ts:64-68` 明写） | 只用 `reason` 原始文案 |
| 工具调用的**中间进度** | 只有 `tool/call` 与 `tool/result` 两端 | 卡片显示 running → 结果 |
| 每一步的**文档 diff** | 只有 `changedObjectIds` | 卡片按 id 描述"改了哪些对象"，不描述改了什么 |
| 推理过程 | 流里有非 `text-delta` 的 chunk，但当前不展示 | 本期继续不展示 |

### 1.2 消息类型与渲染规则

| 类型 | 字段来源 | 渲染 | 折叠策略 | 兜底（解析失败） |
|---|---|---|---|---|
| 用户文本 | `user/message` + `source.kind==='user'` | 右对齐气泡 | 超过 6 行折叠 | 原样显示文本 |
| 助手文本 | `assistant/message` / `assistant-stream` | 左对齐，流式追加 | 超过 10 行折叠 | 原样 |
| 工具调用 | `tool/call`：`toolName` → 中文名表（`client.js:242`） | 卡片：名称 + `running` + R 号 | 单行，不折叠 | 显示「工具调用」+ 空状态 |
| 工具结果 | `tool/result`：`status`、`revision`、`error.code`、`changedObjectIds` | 卡片：状态徽标（applied/rejected/unknown/pending）+ 一句中文摘要 | 摘要一行；细节进"展开" | 显示「已完成（无法解析摘要）」，**不铺 JSON** |
| 审批请求 | `approval/asked`：`toolName`、`reason` | 卡片：⏳ 等待本人在原生会话确认 + 工具名 | 不折叠 | 显示工具名或"未知操作" |
| 审批结果 | `approval/decided`：`outcome` | 卡片：四态中文（`client.js:235-241`） | 单行 | 「审批结果未知」 |
| 错误 | `tool/result.error.code` → 中文表（`client.js:243-257`） | 红色错误条，附下一步动作 | 一行 + 可展开 | 显示 code 原文 |
| 系统提示 | 无独立事件（作为 `user/message` 注入） | **不显示**（`:306` 已过滤） | — | — |

### 1.3 「绝不显示原始 JSON」的硬规则

1. **渲染层不接收原始 JSON**：卡片组件只接收已解析的结构化字段；解析失败时进入兜底分支。
2. **兜底文案固定**：「这一步已执行（无法解析摘要）」，**不展示任何 JSON 片段**。
3. **诊断信息只走剪贴板**：卡片提供「复制诊断信息」按钮，`navigator.clipboard.writeText(原始文本)`，**不渲染进 DOM**。
4. **代码审查口径**：任何把 `JSON.stringify` 结果放进 `children/text` 的提交，视为回归缺陷；在测试里加一条断言——渲染树内不得出现 `"{"` 开头的长文本。
5. 现有 `tool.call.toolview` 卡片已经做到"结果不进正文"（`client.js:604-654`），这条规则是给**面板自建的列表**兜底，两处不要重复渲染同一份内容。

---

## 2. 审批交互：第三方 UI 不能提交，只能看

**证据**：`approval/request` 是**转发的 Remote 事件**，官方 UI 用 `ctx.remote.$on('approval/request', …)`
订阅（`dsh-client-ui-approval/lib/client.js:355`），在组件内部 `this.#resolve(outcome)`
（`:217`）把结果交回 waterfall；**没有任何 `approval/answer` 之类的 Remote 方法**可供第三方调用。
审批服务在 Host 侧（`dsh-user-approval/lib/index.js:128-143`），要求 open turn，只认 `allowed-once`。

因此本期的规则：

1. 面板**只显示状态**：等待中 / 已允许一次 / 已拒绝 / 已取消 / 不可用（`never` 策略或没有 answerer）。
2. 面板提供**唯一的动作**：「打开原生会话」，调用 `workspace.openSession(sessionId)`（已实现，`client.js:231-234`）。
3. **禁止**：伪造「允许」「拒绝」按钮；禁止面板自己发 `allowed-once`；禁止自动重试审批。
4. 若宿主未提供 `openSession`，按钮置灰并写清原因（"宿主未提供原生会话导航"），**不静默降级为假按钮**。
5. 审批结果文案里必须有「尚不能确认绑定成功」这类限定（现有文案已如此），因为 `allowed-once` 之后 Host 还要复验页面与工程。

---

## 3. 共生交互：三条契约

### 3.1 卡片点击 → 定位并高亮画布对象

- **数据来源**：工具结果里的 `changedObjectIds`。图片侧是 `layerId`；视频侧是 `clipId`
  （`video-bridge.mjs:87` 已返回 `changedObjectIds`）。`read_state.selectedObjects` 也可作为补充。
- **通道**：宿主页面 → 编辑器 iframe 的 **MessagePort**，新增一条消息类型：

```js
// host → editor
{ type: 'editor.highlight', requestId: string,
  objectIds: string[],        // layerId / clipId
  ttlMs?: number }            // 默认 1600
// editor → host
{ type: 'editor.highlight_result', requestId: string, ok: boolean, matched: string[], missing: string[] }
```

- **必须遵守**：highlight **只改视觉描边**，**不改 `selection`、不改 `revision`、不进历史**。否则点一下卡片就等于改了文档。
- **前置**：需要在 `public/host/iframe-transport.mjs:82` 的白名单里加这两个类型（当前只有 5 个 `editor.*`）。
- **判据**：`matched` 为空时卡片显示「对象已不存在（可能已被撤销）」，不静默无反应。

### 3.2 编辑器选中 → 面板给出可执行建议

- **通道**：编辑器 → 宿主页面，新增：

```js
{ type: 'editor.selection_changed',
  instanceId: string, revision: integer,
  selectedObjectIds: string[],
  objectKind: 'text' | 'image' | 'shape' | 'clip' | 'overlay' | 'none' }
```

- **定位**：这是**只读通知**，宿主页面不得据此缓存文档（沿用"状态由编辑器唯一持有"）。节流 ≥ 100ms，避免拖动时刷屏。
- **建议从哪里来**：**静态能力表**，不是让模型自由发挥。每条建议形如：

```js
{ label: '把这段文字改成标题字号', operation: 'layer.update_text',
  params: { layerId, text }, requiresApproval: false, enabled: true }
```

- **铁律**：`operation` 不在当前白名单 → **不显示该按钮**（不是置灰）；`requiresApproval` → 点击只填入输入框并提示"这一步需要你单独确认"，**不自动执行**。
- **为什么不让模型产出建议**：模型每次都要一次工具往返，会把 `read_state` 变成高频调用；静态表可离线、可测、可审计。

### 3.3 卡片上「撤销这一步」

- **凭据现成**：`commandId + appliedRevision + afterDigest`，结果与 `read_state.history` 都带
  （图片 `client.js:222` 的五重比对；视频 `video-bridge.mjs:77` 同样校验）。
- **执行方式**：**面板不直接调工具**。按钮把带凭据的指令**填进输入框**（现有 `undoPrompt` 已这么做），用户回车后由会话内的 Agent 执行。理由：面板没有工具调用权；绕过 Agent 就等于绕过审批与审计。
- **文案**：必须写清"仅当这一步仍是栈顶才可撤销，已有后续修改会返回 `HISTORY_CONFLICT`"，与后端返回的中文一致，不要让用户以为一定能撤。

---

## 4. UI 规范增量（含结论）

| 项 | 结论 | 优先级 | 说明 |
|---|---|---|---|
| 分栏可拖拽 | 做 | **P1** | 分隔条只改面板容器宽度与 iframe 的 CSS 尺寸；**严禁重建 iframe 或换 key**，否则工程与撤销栈丢失（这是已经踩过的坑，常驻承载就是为它做的） |
| 窄屏折叠 | 做 | **P0** | 面板宽度 < 720px 时对话折叠为底部抽屉，画布占满；**iframe 保持挂载**，只改可见性 |
| 加载骨架 | 做 | **P0** | 首帧用骨架占位，禁止空白闪烁；骨架高度与实际消息行高一致，避免跳动 |
| 空状态 | 做 | **P0** | 三种：未绑定（给「打开原生会话」）、已绑定无消息（给 3 条示例指令）、解析失败（给"复制诊断信息"） |
| 错误条 | 做 | **P1** | 现有 toast 保留，另加**可停留**的错误条（含 code + 下一步动作），toast 只用于成功提示 |
| 深色模式 | **本期不做** | — | 见 §4.5 |

### 4.5 为什么本期不做深色模式

1. 现有视觉规范是固定的 Apple 浅色（`#f5f5f7` 背景、`#0071e3` 强调、不超过 3 色），做深色要**先把所有硬编码颜色抽成 token**，这是一次全量样式改造，不是"加深色开关"。
2. 宿主是否提供主题信号尚未核实（`prefers-color-scheme` 与宿主 token 谁优先，属于 unknown）。
3. 本期用户诉求是"UI 优化 + 对话框共生"，深色模式**不解决任何一个当前痛点**，做了反而推迟 P0。
4. 建议：0.2.0 先把颜色 token 化（为将来铺路），**开关不发**；0.3.0 再评估。

---

## 5. 优先级

**P0（0.2.0 必做）**
1. 消息类型映射表落地：工具卡片四态徽标、审批四态、错误条文案统一。
2. 「绝不显示裸 JSON」兜底 + 渲染树断言。
3. 空状态三种、加载骨架、窄屏折叠。
4. 卡片「撤销这一步」填输入框（复用现有凭据，零新接口）。
5. 审批卡：只读 + 「打开原生会话」，去掉任何伪造动作。

**P1（0.2.x）**
1. `editor.highlight` 通道 + 卡片点击定位（需改 transport 白名单）。
2. 分栏可拖拽（不重建 iframe）。
3. 可停留错误条。
4. `editor.selection_changed` + 静态建议表（图片先做）。

**P2（后续）**
- 视频侧同构的三条共生通道；深色模式；建议表接入模型（需先解决往返成本）。

---

## 6. 不做项

1. **不在面板里提交审批**（无接口，硬造就是安全漏洞）。
2. **不把 `assistant-stream` 的非文本 chunk（推理）显示出来**。
3. **不在面板里缓存或复制文档状态**（选中通知只用于渲染建议，不留副本）。
4. **不为了让"建议"更聪明而让模型自由生成命令**：建议必须来自静态白名单表。
5. **不做深色模式**（本期）。
6. **不做消息搜索 / 会话列表 / 多会话切换**：面板绑定一个专属会话，切换会话等于换工程，超出本期。

---

## 7. 口径

- **observed**：事件类型与字段（`client.js:301-328`）、审批只能在原生 UI 内 resolve
  （`dsh-client-ui-approval/lib/client.js:217,355`）、`displayReason` 不进审计、
  transport 白名单只有 5 个 `editor.*`（`iframe-transport.mjs:82`）、`changedObjectIds` 两侧都有。
- **derived**：消息类型表、兜底规则、三条共生契约、P0/P1 划分、深色模式结论。
- **unknown**：窄屏断点 720px 是否合适（未做设备实测）；`editor.selection_changed` 的节流对拖动流畅度的影响；
  宿主是否暴露主题信号；`tool/call` 是否稳定携带完整 `arguments`（当前只在卡片里做容错解析）。
