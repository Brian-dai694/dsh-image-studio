# dsh-media-image 改进计划 v3（2026-11-11）

> 起点：0.58.0。工作台连不上 relay 的竞态已修（transport 首次 load、握手时机），
> 无头编辑器的启动与签票已验证可行，子进程环境已清洗。
> 本计划只解决**从现状到"Agent 能在工作台里独立完成一张分层 PSD"**的路径，以及路径上的可靠性。

## 0. 目标与验收

一句话目标：**不依赖人打开页面，Agent 能在一个受控实例里建图层、改像素、导出分层 PSD，并可复核。**

验收（全部可执行、有回执）：

| # | 验收项 | 证据 |
|---|---|---|
| A1 | `npm run verify:live --keep` 打印 4 个 id 并保持存活 | 命令输出 `ok: true` + instanceId/pageId/projectId/ticketId |
| A2 | Agent 用这些 id `bind: true` 成功 | `media_image_read_state` 返回 `image · R0 · projectId …` |
| A3 | 注入 3 张图层素材 | `POST /assets/upload` 回 `asset:<id>`，`read_state.assetsCount` 增加 |
| A4 | 建 3 个真实图层 | `layer.add_image` ×3 → `read_state.layers` 名称与顺序正确 |
| A5 | 导出分层 PSD | `export_start{format:'psd'}` 回 `layerCount=3` + `approximations[]` |
| A6 | 产物可核对 | `parsePsdLayers` 读回 3 层；Pillow 打开合成图与 PNG 逐像素一致 |

**在 A5 通过之前，不得再声称"在工作台里产出了 PSD"。**

## 1. 现状盘点

已具备：
- 命令通道（28 条命令）、PSD 写入器、调色/局部调整数学、素材库、帧率与撤销
- 无头启动 + 签票（`lib/headless-editor.js`，0.58.0）
- 真环境冒烟（`npm run verify:live`）

缺口（按对目标的影响排序）：
1. **一个会话只能绑一个实例**：人和无头实例不能共存，我也因此把本会话打成 stale
2. **无头编辑器没接进工具层**：Agent 侧无法自己拉起，只能人工跑脚本
3. **大文件回传走 base64**：PSD 几 MB，CDP 消息会吃不消
4. **relay 是 100ms 盲轮询**：没有序号、没有补发，断线靠猜
5. **失败只给错误码**：调用方看不出"缺哪个服务"
6. **分发只能手工解包 tgz**，且验证依赖我临时写的一次性脚本

## 2. 分期

### P0（闭环，必须先做）

**P0-1 一实例多链路**
- 问题：`bindings` 以 session 为键、单实例，`SESSION_BINDING_MISMATCH` 即死锁
- 做法：绑定键改为 `(sessionId, instanceId)`；同一 instance 身份下允许多条链路（人开的页、无头页）各自注册、各自重连；`assert` 按 `instanceId` 精确匹配，不再"一个会话一个实例"
- 验收：同时存在人页 + 无头页，两条都能读；关掉一条，另一条继续工作
- 风险：权限面变大 → 每条链路独立授权、独立审计日志
- 量：1 天

**P0-2 工具层接入无头实例**
- 做法：新增显式入口（工具或路由）`media_image_ensure_editor`：无可用实例时用 `createHeadlessEditor` 拉起，返回 ids；**必须显式调用**，不在每次工具调用里偷偷拉起
- 验收：A1 → A2 全自动完成，人不需要开浏览器
- 风险：机器没装 Playwright → 明确 `PLAYWRIGHT_UNAVAILABLE`，不降级假装
- 量：0.5 天

**P0-3 PSD 落盘**
- 问题：`artifactRef` 是页面内 blob URL，`base64` 过大
- 做法：仿 `dsh-canvas-preview`「后台取字节 + 轮询 + 稳定才取」：导出后由页面 `fetch(blob)` 分块写回，Host 侧落盘到任务目录，返回真实路径与 sha256
- 验收：A5 + A6；>5 MB 的 PSD 也能落盘
- 量：0.5 天

### P1（可靠性）

**P1-1 relay 改订阅 + 序号 + 环形缓冲 + resync**（借 dsh2server）
- 现状 100ms 轮询；改事件序号 + 最近 N 条缓冲，断线按水位补发，补不上就 resync
- 验收：断网 5 秒恢复后不丢事件；空载时不再有每秒 10 次请求
- 量：1 天

**P1-2 能力位**
- 工具/路由统一返回 `capabilities`（哪些服务真的可用：抠图服务、生成后端、Photoshop、无头编辑）
- 缺失时返回 `capability_unavailable` 而不是只有错误码
- 量：0.5 天

**P1-3 长任务可中断**
- 导出/批量/重绘：job 化 + 进度 + 取消（借 dsh2server 的暂停语义：中断当前、保留排队）
- 量：1 天

### P2（工程与分发）

- **P2-1 设置页**：`settings.plugins.tab` 挂一个面板（服务端点、是否启用无头、白名单路径）；配置分三层：默认 < cordis.yml < 网页设置
- **P2-2 安装路径**：`dsh plugin --profile web add` 支持（npm / release tgz / github#sha），补 allowBuilds 说明；README 提醒不要 `kill -9`（会中断会话写入）
- **P2-3 测试分层**：`npm test`（单元/替身）保持不变；新增 `npm run verify:live`（真浏览器冒烟）纳入发布前检查清单；P0 的三条验收各补一条真环境脚本

## 3. 明确不做

| 不做 | 理由 |
|---|---|
| 用 `useResource` 重写面板数据层 | 替换的是已经跑通的链路，收益不抵风险 |
| 引入 A2S 的 key/设备聚合体系 | 不需要跨机器控制 |
| 远端终端 | 与目标无关；dsh2server 也明确不实现 |
| 纯 Node 渲染（node-canvas 替换浏览器） | 依赖缺、改造成本高；无头浏览器已验证可行 |

## 4. 顺序与检查点

```
P0-1 一实例多链路 ──► P0-2 接入无头 ──► P0-3 PSD 落盘 ──► 【检查点：A1–A6 全绿，出 0.59.0】
                                                        │
                     P1-1 订阅/序号 ◄───────────────────┘
                     P1-2 能力位
                     P1-3 长任务
                     ──► 【检查点：断网恢复 + 长任务可取消，出 0.60.0】
                     P2 工程与分发 ──► 【检查点：别人一条命令能装，出 0.61.0】
```

## 5. 已知风险

1. **Playwright 不在用户机器上**：无头能力必须可选，缺失时明确报错并给安装提示
2. **会话绑定生命周期**：0.57 已允许显式重绑，但要补"重绑后旧链路如何收尾"的审计
3. **大文件内存**：1198×1198 三层 + 合成图 ≈ 23 MB RGBA，落盘要分块，不能一次性 base64
4. **两实例并存时的写入冲突**：同一工程两人/两链路同时写 → 依赖 `expectedRevision` 冲突检测，需补真环境用例
