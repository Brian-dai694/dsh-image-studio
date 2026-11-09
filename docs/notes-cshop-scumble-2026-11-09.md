# 从 C-Shop 与 Scumble 学到的（2026-11-09 第二轮）

两个仓库都读了源码而非只看 README。这里只记**能落到 dsh-image-studio 的结论**，
以及哪些已经落地、哪些刻意不做。

- C-Shop：`C-Shop`，Rust + Vulkan 原生编辑器，MIT/Apache-2.0，带无窗口脚本驱动、MCP 服务、可选视觉包（ONNX）。
- Scumble：Electron，GPL-3.0，`electron/main/assistant/policy.js` 里有一套宿主侧策略表。

## 1. C-Shop：把「模型能力」做成可选 sidecar

`vision/cshop-vision.py` 的注释讲得很直白：模型跑在独立进程里，脚本/编辑器通过 **JSON stdio** 调用，
「模型坏掉不会拖垮编辑器，不装也不影响其余功能」。

对我们最有用的不是它的模型，而是**契约**：

- 子命令 `inpaint <image> <mask> <out>`，输入输出都是**文件**，stdout 只打一个 JSON 对象；
- 失败也打 JSON（`{"ok": false, "error": ...}`），调用方不需要解析人话；
- 蒙版语义：**1=要重画，0=保留**；只把蒙版覆盖的像素写回，其余保持原图，所以没有接缝；
- 环绕补全：只在洞周围裁一块（外扩 0.5 倍洞的尺寸）送进 512 的模型，而不是整图缩放；
- 空蒙版直接拒绝：`"there is nothing selected to fill in"`。

**已落地**：`lib/inpaint-command.js` 新增 `kind: "command"` 后端，把源图/蒙版写成临时 PNG，
用 `spawn`（**不走 shell**）执行操作者配置的命令，读回 `{output}` 的 PNG 入素材库。
占位符 `{image} {mask} {output} {prompt} {width} {height}`，未知占位符原样保留。
错误码：`INPAINT_COMMAND_FAILED` / `INPAINT_TIMEOUT` / `INPAINT_OUTPUT_MISSING` / `INPAINT_OUTPUT_INVALID`。

这样「本机装了个 python 里画脚本」也能当后端，不必先架 ComfyUI 或 HTTP 服务——
正好补上此前「没有真实后端」的最大阻塞（仍需用户自己装模型，插件不内置、不下载）。

**没做**：环绕补全裁剪。现在整图送后端，因为我们的后端是外部服务、尺寸由它决定；
真要加，应该作为 `command` 后端的一个预处理选项，而不是偷偷改整条链路。

## 2. C-Shop：`measure` —— 让看不见画布的调用方按数字排版

它的脚本层有 `measure text "..." size=54`：报告将要绘制出的尺寸，**不绘制**。
配套的是每次运行都回一份报告（每个图层落在哪、什么失败），因为「它看不见」。

对套版的直接意义：我们的文字槽目前按 `slot.fontSize || min(48, canvasHeight/12)` 猜字号，
放不下就溢出。正确做法是先量再定。

**状态**：未实现。要做需要编辑器暴露 `editor.measure_text`（用 canvas `measureText` + 已加载字体），
再由页面在套版前把每个文字槽的 `style.size` 收缩到槽宽内。已记入下一阶段。

## 3. Scumble：策略在宿主，且作用在「规范化后的调用」上

`policy.js` 的注释点出两个原则：

1. **「宿主决定，永远不是提示词里的规则——模型读到的东西能说服它做任何事」。**
   我们的白名单写在 `lib/bridge.js` 而不是提示词里，这一点本来就一致。
2. **策略作用在 canonical call 上**：`doc` 填好、图层引用解析成真实 id、参数夹紧之后，
   卡片展示的就是**将要发出的东西**；卡片打开期间用户点了别的图层，也不会把调用挪到另一层。

第 2 点我们做了一半：确认框展示的是原始 `payload` 文本，用户无法核对「这个 layerId 到底是哪一层」；
但**确认后重新读 revision、不一致就中止**这条有（`REVISION_CONFLICT`）。
下一步应把确认框改成展示解析后的图层名/坐标，而不是 JSON 片段。

另外三条值得抄：

- `REFUSE("this exact call failed twice; change it or ask the user")`——同一个调用失败两次就拒，
  避免模型原地打转。我们现在会一直重试。
- `READS` / `RUNS` 分组：只读工具不等待、不因忙碌拒绝；会排队或花钱的工具在文档忙碌时直接拒。
- `undoStep(call)`：明确每个调用要推哪种历史步，保证 Ctrl+Z 一定撤得掉。
  我们是靠原生 action 自带撤销，等价，但没有「某些字段不产生撤销步」的显式表。

**没做**：失败两次熔断、canonical 确认卡片。前者简单（记 `commandId+payload` 哈希计数），
后者要先有「解析引用」的中间层。

## 4. 两者共同的一条：脚本与 UI 走同一份实现

C-Shop：「Nothing here is a second implementation: a script drives the identical code the interface drives」。
Scumble 的 policy 也是包在既有 tool 外的判定，不复制执行逻辑。

我们的对应物是 `miniPaint/src/js/dsh-editor-bridge.js`：页面的快捷指令和模型的 `media_image_*`
最终都落到同一批白名单命令上，没有第二套写入路径。这条要继续守住——
新增能力时只加命令，不给某个前端单开短路。

## 5. 刻意不抄的

- **MCP 服务层**：C-Shop 用它把编辑器暴露给网络；我们已经有 DSH 的 tool 面，
  再叠一层 MCP 只会多一处鉴权面。
- **GPU/Vulkan 合成**：miniPaint 是 canvas 2D，换引擎等于重写，收益不在当前目标里。
- **Scumble 的 Comfy 路由全家桶**（comfycloud/comfyrouter）：它是为多后端计费与配额设计的，
  我们保持「一个 provider 一种 kind」的薄适配。

## 参考位置

| 主题 | 文件 |
|---|---|
| 无窗口驱动三层 + measure | `c-shop-main/docs/AGENTIC.md`、`docs/SCRIPTING.md` |
| 服务端收敛规则 | `c-shop-main/docs/SERVING.md` |
| 视觉包（inpaint 契约） | `c-shop-main/vision/cshop-vision.py` |
| 宿主策略表 | `scumble-main/electron/main/assistant/policy.js` |
