# 工程授权契约 v1（会话 × 工程 × 编辑器实例）

> 适用于 `dsh-media-image` 与 `dsh-media-video`。一页，够实现。

## 1. 授权是什么

一个**授权（grant）**表示：**某个真实会话**可以读/写/导出**某个具体工程**，且它绑定在**某个具体编辑器实例**上。

```
grant = { grantId, sessionId, editorKind, projectId, instanceId, pageId,
          source: 'native' | 'panel', issuedAt, expiresAt }
```

- `sessionId` **只能**来自真实 `ToolRunContext`（`exec.agent.id` 且与 `exec.agent.session.id` 相等），永不接受模型参数或页面自报。
- `pageId` 必须来自 relay 的实时页面记录，不能由调用方提供。
- 一项授权只对一个 `(sessionId, projectId, instanceId)` 三元组成立；换工程、换页面、页面断开即作废。

## 2. 两种来源，信任等级不同，必须如实标注

| source | 何时使用 | 证明了什么 | 证明不了什么 |
|---|---|---|---|
| `native` | 宿主 `approval` 服务可用且策略为 `ask` | **人**在一次 DSH 审批提示里点了「允许一次」 | — |
| `panel` | 审批不可用（策略 `never` / 无 answerer） | **控制这个编辑器页面的一方**同意授权 | 不等于是"人"点的 |

优先级：**能走 `native` 就走 `native`**。`panel` 是降级路径，不是替代品。两者都要写审计并在 `read_state` 里带出来，不得混同。

## 3. 面板授权的票据（bindTicket）

审批不可用时，走一次性票据。**票据由 Host 签发，不由面板签发。**

```
签发：面板 → Host（同源 + pageToken）  POST /media/grant/ticket
      请求体只含 { instanceId }
      Host 校验：pageToken 属于该 instanceId 且页面存活 → 生成
      bindTicket = { ticket, editorKind, projectId, instanceId, pageId, expiresAt: now+5min, used: false }
      **票据此时不带 sessionId**——面板不知道真实会话，也不允许它指定。

消费：工具调用 read_state { bind: true, ticket }
      Host 流程：票据存在 → 未过期 → 未使用 → pageId 与 relay 实时页面一致
                → projectId 与编辑器当前 documentId 一致 → 读一次快照
                → 用**真实 exec.sessionId** 落 grant → 票据标记 used
      任一步不符：拒绝且**票据作废**（不可重放）。

使用中：assert() 每次校验 grant 未过期 + 页面仍存活 + 三元组一致。
作废：页面断开 / 换工程 / 过期 / 面板点「解除授权」。
```

**为什么票据不带 sessionId**：只有工具调用知道真实会话。面板若指定 sessionId 就是自报身份，整条链就废了。票据证明"这一页同意过"，会话身份由 `exec` 当场补上。

**为什么票据必须绑 pageId**：否则一个页面的同意可以被拿到另一个页面/工程上重放。

## 4. 状态与错误码（不许伪装）

`read_state` 必须带：

```js
grant: { source: 'native'|'panel', grantId, issuedAt, expiresAt, expiresInMs } | null
```

无授权时 `state.status = 'rejected'` 且：

| 场景 | code | 文案要点 |
|---|---|---|
| 完全没授权 | `SESSION_BINDING_REQUIRED` | 「尚未授权：请在编辑器面板点一次『授权此会话读写本工程』」 |
| 策略 `never` / 无 answerer，模型请求了 `bind:true` | `SESSION_APPROVAL_UNAVAILABLE` | **不得**再报 `APPROVAL_DENIED`（那会被理解成"用户拒绝了"，实际是"根本没弹"） |
| 票据过期 | `BIND_TICKET_EXPIRED` | 重新点授权 |
| 票据已用 | `BIND_TICKET_CONSUMED` | 一次性，重新点 |
| 页面/工程变了 | `SESSION_BINDING_STALE` | 重新授权 |
| 授权过期 | `SESSION_BINDING_EXPIRED` | 重新授权 |

**"未授权"和"未就绪"必须分开报**：前者要人去点，后者只要等。

## 5. 六条铁律

1. **不得静默授权**：没有票据、没有 `allowed-once`，一律拒绝，永不自动补授权。
2. **Agent 不得代点**：模型不能创建票据、不能调用解绑、不能伪造 `allowed-once`；它只能"使用"已存在的一次性票据。
3. **票据一次性**：消费成功或失败都作废，5 分钟硬过期。
4. **解绑同样要本人点**：解绑只从面板发起，模型侧没有入口；解绑写审计。
5. **不得用自报身份绕过**：任何来自页面的 `sessionId`、`grantId`、`role` 都不采信。
6. **来源必须可见**：`read_state`、审批文案、审计日志三处都要能看出是 `native` 还是 `panel`。

## 6. 有效期

- 票据：**5 分钟**，一次性。
- 授权：**8 小时**软上限，且受"页面存活 + 同一工程"两个硬条件约束，任一不满足立即作废。

## 7. 验收（按协作本身判，不按接口判）

**正向闭环（图片、视频各一遍）**
1. 桌面端面板点一次「授权此会话读写本工程」→ 三态从「未授权」变「已授权」。
2. 会话里 `read_state` → 返回**真实** canvas（图片）/ timeline+tracks（视频），**不是空壳**。
3. `apply_command` 加一个文字图层 → 编辑器上立刻出现，`revision + 1`。
4. 用户手动撤销 → 模型再 `read_state` → 看到回退。

**负向（每条都要有断言）**
1. 未授权时 `read_state` 返回 `SESSION_BINDING_REQUIRED`，且策略 `never` 下**不出现审批卡**。
2. 同一票据用第二次 → `BIND_TICKET_CONSUMED`。
3. 票据超过 5 分钟 → `BIND_TICKET_EXPIRED`。
4. 授权后换工程（重开/换文档）→ 旧授权失效，写入被拒。
5. 模型尝试"解绑"或"自动授权" → 无此入口，工具直接不识别该 operation。
6. `read_state.grant.source` 与实际路径一致（native 显示 native，panel 显示 panel）。

## 8. 不做

- 不做 HTTP `claim(sessionId)` 之类的自认领接口。
- 不让面板签发或校验票据。
- 不在授权缺失时自动降级为"只读"（会造成"能读不能写"的静默半残状态，比直接报错更难查）。
- 不把 `panel` 授权包装成"已通过人工审批"。
