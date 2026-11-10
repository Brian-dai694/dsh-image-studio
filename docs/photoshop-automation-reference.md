# Photoshop 自动化参考研究：MCP 桥与 dsh-media-image

日期：2026-11-09  
范围：用户提供的 `photoshop-beta-control-main.zip` 静态源码 + `@alisaitteke/photoshop-mcp` 当前 GitHub `master` 的公开 package/tree 元数据；不安装依赖、不连接 Photoshop、不运行第三方代码。

## 摘要

文章的方向有一部分成立：Photoshop 自带 COM/ExtendScript（Windows）等脚本入口，MCP 可以把结构化操作暴露给 Agent。但它把“能调用脚本”与“能可靠理解界面、验证视觉结果”混在一起了。两个参考项目的当前公开资料都更像**结构化工具桥 + 操作配方**，不是证明 AI 能自主审美或精确操作任意 UI。

对 dsh-media-image 最值得拿走的是：

1. 一个意图对应一个参数受限、可校验的工具；复杂原生细节留在 bridge。
2. 把高频领域操作做成可复用 recipe（我们在 0.34.0 已实现命名、参数化 recipe）。
3. 视觉编辑应有“执行前预览目标区域、执行后测量/复核”的闭环（我们已有 preview/analyze、0.33 的 overlay）。
4. 本地应用控制必须有超时、稳定错误、明确的破坏性边界和回退；COM/ExtendScript 不能等同于可取消、可回滚事务。

**不建议照搬：**把任意 JSX 暴露成默认工具、用大量工具数量作为能力证明、或在没有 Photoshop/Windows COM 的当前 DSH 编辑器中引入 COM/AppleScript 层。

## 来源身份与覆盖范围

| 目标 | 身份证据 | 覆盖与限制 |
|---|---|---|
| `photoshop-beta-control-main.zip` | 用户本地 ZIP；解压副本 `C:\Users\UEFR\Downloads\study-photoshop-beta-control-main\photoshop-beta-control-main`。包内 README 声称 Windows、Photoshop COM、ExtendScript；`package.json`/`.codex-plugin/plugin.json` 声明插件入口。 | 读取 README、MCP server、PowerShell bridge、Skill、示例和 CI；没有安装、没有运行、没有连接 Photoshop。源码/CI 只能证明静态结构与声称的检查步骤。 |
| `@alisaitteke/photoshop-mcp` | GitHub `master` 在本次查询返回 commit `ba36d8f2a28ecc56686568f3c0191e388336d498`；其 `package.json` 当前版本为 `1.7.37`，description 声称 128 tools。 | 已取 package metadata 与递归 tree；README raw 请求超时，没检查全部实现文件，也没运行/连接 Photoshop。工具数量是仓库包声明，不是独立能力验收。 |

## 证据表

| 观察 | 源位置/证据 | 含义与边界 |
|---|---|---|
| 插件按 MCP `tools/list` / `tools/call` 暴露工具 | 本地参考 `scripts/mcp_server.py`：`TOOLS` schema，`call_tool`，`handle` | 是 MCP 服务器，不是读屏鼠标 Agent。 |
| MCP 请求经 Python `bridge()` 写临时 JSON，再启动 PowerShell bridge | 本地参考 `scripts/mcp_server.py`：`bridge()` | 可复用的“协议层与宿主适配层分开”结构。 |
| Photoshop 连接用 COM ProgID 探测/附着，并调用 `DoJavaScript` | 本地参考 `scripts/photoshop_bridge.ps1`：`Get-PhotoshopApplication`、`Invoke-PhotoshopJsx` | 是 Windows COM + JSX 自动化；非 Photoshop Beta UI Accessibility 树控制。 |
| `photoshop_run_jsx` 是任意 JSX 能力 | MCP tool schema 与 PowerShell `run_jsx` 分支 | 权限很宽；Skill 文档承认 JSX 可读写主机文件。应当视为高风险原生代码执行口，不应默认开放给模型。 |
| 预设结构化工具可编辑文字、图层、路径、调整、导出 | `mcp_server.py` 的 tool schemas；`photoshop_bridge.ps1` 的 action switch | 结构化工具比临时拼 JSX 更适合白名单验证、入参校验与用户确认。 |
| 局部换色采取“导出底图→按多边形/颜色评分构 mask→羽化→生成透明 overlay→作为新层放回 PS” | `mcp_server.py`：`texture_recolor()` | 与我们“新层 + 蒙版 + 原图保留”目标一致；但目标颜色识别使用启发式红/绿/蓝/亮度评分，非语义分割，复杂颜色/相近背景精度未知。 |
| 批处理是顺序调用，默认 stop-on-error | `mcp_server.py`：`batch()`；`docs/TOOLS.md` | 文档没有证明 batch 是原子事务，也没有看到它失败时自动回滚已成功步骤；不要与我们 `history.batch` 的单步撤销/失败回滚混称。 |
| 每次桥调用有 timeoutSeconds，默认 45 秒 | `mcp_server.py`：`bridge()` 的 `subprocess.run(timeout=...)` | 对阻塞有上限；超时错误后临时 JSON 会在 `finally` 删除。`subprocess.run` 会等待并清理被杀掉的子进程，但 Photoshop COM 服务器端副作用是否已发生/是否能中断仍需运行验证。 |
| ProgID 可配置、优先级明确 | `photoshop_bridge.ps1`：参数 `ProgId` → `PHOTOSHOP_PROG_ID` → 注册表 → 常见版本候选 | 比文章里写死某个 bundle/ProgID 更有跨版本韧性；仍只适用于本机 COM 已注册并可访问的 Windows 环境。 |
| 仓库 CI 声明检查 Python 编译、JSON、PowerShell 语法和 MCP tools/list | `.github/workflows/ci.yml` | 这是 CI 配置的静态观察，本次没有执行该 CI，也没有确认线上最近一次通过状态。 |
| Photoshop MCP 当前包有 Windows/macOS 平台桥、128 工具声明、recipe、MCP server 与独立 UI | 上游 `package.json`；GitHub tree：`src/tools/recipes/*`、`src/ui/agent/*`、`src/ui/server.ts` | 说明项目已不止简单桥；但工具数/功能文字是仓库声明。因 README 请求超时、未检查全部源码，本笔记不推断其事务性或视觉验收实际效果。 |

## 与 dsh-media-image 对照

| 设计问题 | Photoshop COM/MCP 参考 | dsh-media-image 当前设计 | 建议 |
|---|---|---|---|
| 编辑器真源 | 本机 Photoshop 文档，经 COM/JSX 修改 | 浏览器 miniPaint 的共享工程，经 `editor.*` relay 修改 | 保持 miniPaint 为本插件的唯一真源；不要把 Photoshop COM 假设嫁接到 Windows/DSH 浏览器编辑器。 |
| 原子能力 | 结构化工具生成 JSX；另有任意 JSX 工具 | 18 条图层/像素命令白名单 + `expectedRevision`/幂等 commandId | 继续小工具 + 严格参数校验；任意 JSX 只适合隔离的可选外部桥，且必须单独高风险审批。 |
| 批量 | 顺序调用、默认停错；未见整体 undo 证据 | `history.batch` → 原生 `Bundle_action`，一条历史、失败回滚 | 保持我们的原生事务优势；不能仅因参考项目也有 batch 就替换。 |
| 可复用工作流 | Photoshop Actions + Recipes 工具 | `media_image_recipe`，参数化并持久化；单步撤销 | recipe 的方向相同。后续重点是把用户可审核的输出预览和证据接入 recipe。 |
| 纹理保留换色 | 遮罩 + HLS 色相重映射 + 亮度混合，创建 overlay 新层 | 当前 `layer.color_match` 是整层 Reinhard 颜色匹配；活蒙版与图层遮罩机制已建 | 可借鉴“局部遮罩 + 保纹理 recolor”的产品能力，但应重用我们的活蒙版/非破坏图层，并提供 before/after overlay；不照搬其启发式阈值当可靠语义。 |
| 结果复核 | 上游 package/tree 声明 preview、recipes、独立 UI | `media_image_preview`、grid/overlay、`media_image_analyze` | 继续以真实像素/尺寸/遮罩区域作证据；不把 OCR/模型“看起来好”当验收。 |
| 运行错误治理 | Python subprocess timeout；PowerShell 错误转 JSON | 本地 command provider 有 timeout、退出码、输出签名/尺寸校验；刚补了等待 close 再清理 | 继续保留；Windows Photoshop COM 若另接，需单独核实 COM 调用阻塞时的取消语义，不能假设杀客户端就回滚 Photoshop 操作。 |
| 平台与依赖 | COM 项目仅 Windows；`photoshop-mcp` 当前包声称 Windows/macOS 两路 | miniPaint 浏览器编辑器与 DSH Host，平台隔离于 OS 原生 PS 控制 | 本机不是 Photoshop COM 目标，当前场景应以 miniPaint 工作流为主。 |

## 安全与信任边界

- `photoshop_run_jsx` 能执行任意 ExtendScript；源文档明确承认它有主机文件系统访问能力。若未来加入外部 Photoshop provider，JSX 不可作为普通低风险工具开放；须脚本审阅、显式审批、独立进程超时与文件访问边界。
- 文件路径、导出路径与 overlay 路径是本机文件操作输入；工具必须拒绝越权路径/意外覆盖，并优先输出新文件。
- 批处理默认 stop-on-error 不是回滚保证。应区分“停止后续步骤”“补偿回滚”“原生原子 undo”三个语义。
- 局部换色会将底图导出到临时文件，Pillow 生成 overlay 后再导回 Photoshop；必须验证临时文件清理、原图不变和 overlay 可单独删除。参考源码有临时目录创建，本次未验证目录清理路径。
- `photoshop_beta_control` 文档声称本地处理且不主动上传；这不自动涵盖 Codex 会话自身读取/写入本地文件的范围。信任描述不能替代 MCP 调用审计。

## 采用决策

**采纳（按当前工程改写）：**结构化 Photoshop 原生工具模式；领域 recipe；可编辑文本/路径/图层的交付概念；局部换色使用遮罩与新 overlay 保留源像素；单次桥调用超时；兼容 ProgID 探测思想（仅当将来有真正 Photoshop COM 用户场景）。

**不直接移植：**COM/AppleScript/PowerShell bridge、任意 JSX、工具数量、示例里的坐标/模型宣传、未经运行验证的多平台支持。它们与当前 miniPaint 浏览器编辑器边界不同。

> **后续变更（2026-11，本人指示）：**上一条里的「任意 JSX」与「PowerShell bridge」已被推翻 ——
> 现在两者都在：`scripts/photoshop-bridge.ps1` + `media_image_photoshop_action`（固定 action）与
> `media_image_photoshop_run_jsx`（任意 ExtendScript，`confirm:true`，无沙箱无自动回滚）。
> 本文其余研究结论照旧，这一行只记录决策变化，避免文档自相矛盾。

**建议下一项能力（未实现）：**新增 `layer.recolor_masked` 白名单像素命令：目标活蒙版/选择范围 + 目标色 + 强度 0..1 + 混合策略；算法保留原像素亮度/纹理，先生成独立结果层或 preview，再经审批合成。验收：同一纹理输入变色后亮度排序/明暗纹理保留、mask 外 RGB/alpha 完全不变、强度 0 为 no-op、撤销一步还原；若用户没有要求实现，本笔记只记录推荐，不自行启动生成或安装外部 MCP。

## 下一步最小验证

1. 若要继续研究上游 `photoshop-mcp`：优先检查 `src/tools/recipes/*`、MCP tool registry、PS bridge timeout/locking、preview/analyze/review 实现与对应 tests；当前只完成 package/tree 级静态核验。
2. 若要把“局部保纹理换色”纳入 dsh-media-image：先定义 `layer.recolor_masked` 的像素语义和非破坏图层合同，再实施纯函数测试与真实浏览器验证。

本报告没有安装或运行两个参考项目，也没有连接 Photoshop；所有第三方能力为静态源码/仓库声明，运行时成功率仍未知。
