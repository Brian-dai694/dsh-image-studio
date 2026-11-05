# 版本 DAG 设计提案（v0.1 草案）

> 状态：提案，**未实现**。本文件同时适用于两个仓库：
> `dsh-image-studio`（主）与 `dsh-video-studio`（同构，本期只做图片）。
> 写作时只读代码，未修改任何实现。

## 0. 结论

用户说的"非线性"不该理解成"把编辑器塞进会话图"。`dsh-synapse` 的非线性是**会话图**，
换的是容器，剪辑本身的线性（一条时间轴）不会因此消失。真正有价值的是在
`revision + digest + commandId + 历史栈` 之上做**版本 DAG**：命名快照、分支、对比、合并。

现状能支撑到 **"命名快照 + 恢复"**，但支撑不了分支合并，原因不是缺字段，而是**当前的内容标识
本身不可靠**（见 §1.1）：图片的 digest 不含像素、却含"当前选中"；视频的 revision 含 seek 而
digest 不含。这两个问题不先修，DAG 就是建在沙子上。

建议三步：**①命名快照与恢复 → ②分支=快照+标签 → ③对比与三方合并**，图片先做，视频后做。

---

## 1. 现状体检：能支撑到什么程度

### 1.1 三个必须先承认的"内容标识"缺陷

| # | 缺陷 | 证据 | 后果 |
|---|---|---|---|
| a | **图片 digest 不含栅格像素** | `documentState()` 只取图层元数据与文本 `data`，不含 `layer.link`（像素画布）——`miniPaint/src/js/dsh-editor-bridge.js:78-84` | `layer.feather` / `layer.color_match` 改的是像素，**前后 `stateDigest` 完全相同**；同一 digest 对应两个不同内容的 revision |
| b | **图片 digest 含 `selected`** | 同上，`documentState()` 第一项就有 `selected: config.layer?.id` | 仅仅"选中另一层"就会被算作内容变化；revision 会因 UI 操作增长，污染 diff 与节点身份 |
| c | **视频 revision 含 seek，digest 不含** | 每条命令都 `revision + 1`（`video-state.mjs:264`），包括 `timeline.seek`（`:256-258`）；而 `stateDigest()` 只取 `source / timeline.duration / fps / tracks / overlays`（`:269-273`） | 拖动播放头会涨 revision 但不改 digest；反过来 `selection` 变了也不进 digest |

由此推出：**现有的 `(revision, digest)` 组合不是内容地址**，只能当"乐观并发令牌"用
（这也正是它今天的用法）。要建 DAG，必须先拆出两个概念：

- `contentDigest`：只覆盖**文档内容**（图层/轨道/像素摘要），不含 `selected`、`currentTime`；
- `viewState`：`selected`、`currentTime`、缩放等 UI 瞬时态，**不进节点身份**。

另附一条：两边 digest 都是 **FNV-1a**（图片 `fnv1a64`、视频 `fnv1a32`），不是密码学哈希。
做本地相等比较够用，但**不能跨机器做内容寻址、也不能防篡改**。若将来要交换分支，换
SHA-256（WebCrypto 现成），FNV 保留做快速预比较。

### 1.2 现有机制能不能复用

| 机制 | 现状 | 对 DAG 的可用性 | 缺什么 |
|---|---|---|---|
| `revision` | 图片：由"指纹变化"驱动的单调计数器（`dsh-editor-bridge.js:90-100`）；视频：每条命令 +1（`video-state.mjs:264`） | 可作**全局递增序号**，不能作节点 id | 与内容解耦（见 §1.1） |
| `stateDigest` | 页面计算，Host 只透传（`tools.js` 里多处 `state.stateDigest`） | 可作**内容指纹**的雏形 | 见 §1.1 三条 |
| `commandId` | 幂等记录，**只在编辑器生命周期内**，上限 10000（`dsh-editor-bridge.js:251-256`） | 可作"这一步是谁改的"审计键 | 进程重启即失效，不能当历史主键 |
| 图片历史栈 | miniPaint `action_history` + `action_history_index`（`core/base-state.js:94-96`），有内存回收、会丢最旧动作（`:157-195`） | 可作**当前分支的本地撤销** | 不是图，不能跨分支；且会被裁剪 |
| 视频历史栈 | `{past ≤100, present, future}` 纯 JSON（`video-state.mjs:99-104`） | 同上 | 同上 |
| 定向撤销 | 五重比对：`commandId + appliedRevision + afterDigest + historyIndex + action 引用`（`dsh-editor-bridge.js:222`、`:349`） | 已经是"栈顶校验"，合并后可复用 | 只对**栈顶**有效，跨分支无意义 |
| 工程序列化 | miniPaint 已能导出含 `data`（dataURL）的 JSON（`modules/file/save.js:708-719`） | **快照可以直接复用这个形状** | 需要稳定 id 与素材 ref |

**结论**：能无损变成"每分支一条历史"的，只有 **"当前文档状态"** 这一部分。
缺的三块是：**跨生命周期的内容摘要、持久化快照存储、分支指针**。

---

## 2. 两个编辑器的成本差异：图片先做

| 维度 | 图片（miniPaint） | 视频 |
|---|---|---|
| 状态体积 | 大：图层次 + 每层像素（可 dataURL） | 小：纯 JSON（tracks/clips/overlays） |
| 媒体依赖 | **自包含**：像素在文档里 | **不自包含**：clip 只存 `sourceRef`，媒体在页面内存的 `elements`（`video-sources.mjs:1-3` 明写"重开工程需重新选同一个文件"） |
| 历史实现 | 原生 `action_history`，动作自带 do/undo | 自建 JSON 栈 |
| 恢复成本 | 恢复后视觉可逐像素比对 | 恢复后可能"没有画面"，要先重新绑定媒体 |
| 已知坑 | `pixelBases` 首帧快照缓存只活在编辑器内（`dsh-editor-bridge.js:69-71`） | `createMediaElementSource` 对同一元素只能绑定一次（`video-export.mjs:126-133`），反复切分支有失声风险 |

**裁决：图片先做，视频延后到 P2。** 四个理由：

1. 图片状态自包含，快照能否信任**当场可验**（恢复后 `contentDigest` 必须相等）；
2. 视频就算 DAG 全对，媒体引用失效会让"分支恢复"看起来像播放 bug，**架构问题会被误判成渲染问题**；
3. 图片的撤销证据链已经闭环（原生 action + 五重比对），视频还需要先把 §1.1 的 digest 修对；
4. 视频对 DAG 的真实需求（多版粗剪对比）不急，先用"命名快照"顶住。

---

## 3. 最小可行三步

### 第 1 步：命名快照与恢复

**不改现有工具数**，先加两个 operation（沿用 `apply_command` 的白名单，走同一条 revision/审批管线）：

```
snapshot.create  { name?: string(≤120), note?: string }
  → { snapshotId, contentDigest, revision, createdAt }

snapshot.restore { snapshotId, expectedRevision }
  → { revision, contentDigest, restored: true }
```

- **存哪里**：文档与像素存编辑器的 IndexedDB；**Host 只存元数据**（`snapshotId / name /
  contentDigest / revision / createdAt / 大小`）。这样仍然满足"状态由编辑器唯一持有、Host 不缓存文档"。
- **存什么**：复用现有 JSON 导出形状（图层含 `data` dataURL），另加 `schemaVersion` 与
  `sourceRefs[]` 清单。不做增量，先做全量（1200px 级文档可接受）。
- **恢复语义**：必须走**一条原生动作**，因此可撤销；`revision` 继续 **+1，不回退**；
  恢复后重新计算 `contentDigest`，**必须等于**快照记录值，否则拒绝并报
  `SNAPSHOT_DIGEST_MISMATCH`（防止快照损坏静默生效）。
- **必须做的副作用清理**：恢复时清空 `pixelBases` / `pixelApplied`（`dsh-editor-bridge.js:69-71`）。
  否则羽化/调色会拿"上一个分支的首帧快照"当基线，静默产出错图——这是最容易漏的一条。
- **硬规则**：恢复**不能清空历史**；想回到恢复前，撤销这一步即可。

### 第 2 步：分支 = 快照 + 标签

**不新增文档结构**，只在 Host 侧维护：

```
{ branchId, name, headSnapshotId, parentBranchId, createdAt }
```

编辑器根本不知道"分支"这个词。三个 operation：

```
branch.create   { fromSnapshotId, name }   → { branchId }
branch.checkout { branchId, expectedRevision } → { revision, contentDigest }
branch.list     {}                          → { branches: [{branchId, name, headSnapshotId, revision}] }
```

- `branch.checkout` ≡ `snapshot.restore(head)` + Host 切换当前分支指针。
- **硬规则（已定）**：checkout 必须是"恢复已有内容"。快照加载失败时**停在当前文档并报错**，
  **禁止**"先清空再加载"——那正是"切分支后工程变空白"这类事故的根源。
- 分支的"历史"= 快照父子链 + 该分支上的 `commandId` 序列（Host 审计日志已有）。
  **不把 miniPaint 的 `action_history` 改造成图**：它是实现细节，跨分支没有意义。

### 第 3 步：对比与三方合并

```
branch.diff  { a: branchId, b: branchId } → { alignment, added[], removed[], modified[], conflicts[] }
branch.merge { from: branchId, into: branchId, strategy: 'manual' } → { mergeSnapshotId, conflicts[] }
```

**对齐键**：图片按 `layerId`；`layerId` 不稳定时（用户复制图层会换 id）降级为
`(name, order)` 对齐并显式标注 `alignment: 'heuristic'`。视频按 `trackId` / `clipId`。

**合并规则（具体到字段，三方 base = 两个分支最近的公共祖先快照）**：

| 情形 | 规则 |
|---|---|
| 只有一边改了某字段 | 取改动侧 |
| 两边都改、值相同 | 取该值 |
| 两边都改、值不同 | **冲突**：两个对象都保留（副本加 `(冲突 from A)` / `(冲突 from B)`），返回 `MERGE_CONFLICT`，等人工选 |
| 一边删除、另一边修改 | **冲突**，不自动删 |
| 两边都改了同一图层的**像素** | **一律冲突**，保留两份 |
| 新增图层 id 撞车 | 重命名后作为两条独立对象保留 |

**明确不自动合并像素**：三方像素合并需要像素级 base，且视觉结果无法自动判定，
硬合等于静默毁图。冲突一律交人工。

合并本身也是一条可撤销动作：`merge.apply` 产生一个新 revision + 一个 `mergeSnapshot`，
并记录 `mergeBaseSnapshotId`，便于事后回溯"这一版是从哪两版合来的"。

---

## 4. 明确不做

1. **不引入 `dsh-synapse` 的任何代码、会话图或节点模型**；编辑器不会变成"图里的一个节点"。
2. **不做 CRDT / 实时多人协同**：我们的场景是"一个人 + 一个 Agent 共用一个文档"，不是多用户。
3. **不做分支切换时重建空工程**（硬规则，见 §3 第 2 步）。
4. **不把 miniPaint 的 `action_history` 改造成 DAG**：跨分支无意义，且它会被内存回收裁剪。
5. **不做"自动挑选胜者"的合并**：冲突必须人工选。
6. **本期不做视频分支**，只在契约上预留同构位置。

---

## 5. 风险与工作量

### 5.1 对现有契约的影响

- `branchId` / `snapshotId` 全部是**可选字段**；不传时行为与今天完全一致（单线）。
- **`revision` 语义不变**：仍然全局单调递增，**不随分支重置**。这是关键决定——
  否则"同一 revision 号对应不同内容"，会把审批绑定、幂等、定向撤销全部搞乱。
- 新增错误码：`SNAPSHOT_NOT_FOUND`、`SNAPSHOT_DIGEST_MISMATCH`、`BRANCH_NOT_FOUND`、
  `MERGE_CONFLICT`、`SNAPSHOT_TOO_LARGE`。
- 现有审批绑定（`gate.js` 的 `revision + stateDigest` 比对）**不受影响**：`revision` 仍兜底。

### 5.2 主要风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 快照体积 | 图片像素全量存 | 先全量（可接受），后续按"素材 ref + 可重放动作"瘦身 |
| 恢复后基线错乱 | `pixelBases` 未失效 → 羽化基于旧图 | 恢复流程强制清理，并加一条断言测试 |
| 定向撤销对像素命令无效 | `digestOf(documentState())` 不随像素变（`:349`），实际靠 `historyIndex`/`action` 兜底 | 修 §1.1(a) 后自然解决 |
| 合并后 id 变化 | 合并产生的副本是新 id，旧 `commandId` 绑定的定向撤销会失效 | 合并快照重置 commandId 绑定 |
| 视频切分支失声 | 元素只能绑一次 `MediaElementSource` | 视频分支延后；届时改为"复用元素 + 重接线" |

### 5.3 工作量（估算，非承诺）

| 阶段 | 估算 |
|---|---|
| ① 快照 + 恢复（图片） | 2～3 天 |
| ② 分支标签 | 1 天 |
| ③ diff + 三方合并（图片） | 4～6 天 |
| 视频对齐（P2） | 另计，取决于媒体重连改造 |

---

## 6. 验收标准（可执行）

1. **快照**：同一文档改 3 次 → `snapshot.restore` → `contentDigest` 与快照记录**完全相等**；
   再撤销一次，回到恢复前状态与 digest。
2. **快照损坏**：手工篡改快照中的一张图层 dataURL → 恢复必须报 `SNAPSHOT_DIGEST_MISMATCH`，
   且**画布不被部分修改**。
3. **分支**：A 分支改图层名、B 分支改同一图层位置，来回 checkout 三次，两边内容都不丢；
   构造"快照缺失"的 checkout，必须停住并报错，**不出现空白工程**。
4. **合并**：同字段两边都改 → `MERGE_CONFLICT` 且冲突对象两份都在；只一边改 → 自动取该侧；
   一边删一边改 → 冲突不自动删。
5. **回归**：不带 `branchId` 的旧调用路径行为不变，两个仓库现有测试全绿。

---

## 7. 口径

- **observed**：§1.1 三条缺陷、各文件行号、历史栈实现、JSON 导出形状、媒体不持久化、
  `MediaElementSource` 一次性绑定——均在本机源码读到。
- **derived**：`contentDigest` / `viewState` 的拆分、全局递增 revision、"分支 = 快照 + Host 标签"、
  三方合并冲突表、图片先做——都是据此推导的设计结论。
- **unknown**：图片快照的真实体积与恢复耗时（未实测）；IndexedDB 在隔离实例/多标签下的容量上限
  （未验证）；合并 UI 的交互形态（未设计）。
