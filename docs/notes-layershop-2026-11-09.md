# 从 LayerShop 深度学习（2026-11-09）

对象：`layershop`（Rust，MIT/Apache-2.0，PhotoCraft 系）。31 个 crate、约 70 篇 docs。
这里只写**能改变 dsh-image-studio 决策**的部分，每条都带位置，并标明「已对齐 / 待改进 / 不采纳」。

## 1. 局部重绘的产物形态：我们的设计和成熟实现一致

`docs/ai-generation.md:285`：

> The result is a **new layer** above, masked by the selection. The layer you selected on is not
> changed; hide or delete the new one to compare, or paint on its mask to blend the edge.

**已对齐**。我们的 `layer.add_image {maskRef: layer:<蒙版>}` 同样是「新图层 + 蒙版、原图不动」，
所以这条路不需要重做。

## 2. 送给模型的蒙版要**羽化**，不是硬边

`docs/ai-generation.md:282-284`：

> the mask fades in over the outer eighth of the selection: there the picture is kept more and
> more, which makes the model compose what it paints **inside** the selection … and joins it to
> the picture without a seam.

**待改进**。我们两条输入路径里，蒙版图层那条会带上用户羽化过的 alpha；但**选区那条是硬边**
（`host.js` → `exportInpaintInputs`：`ctx.fillRect` 纯白）。后果是模型容易把主体画到选框边缘之外，
或接缝可见。改法很小：导出前对选区蒙版做 `blurAlpha(r/8)` 级别的渐隐（我们已经有
`blurAlpha` 与 `featherPx`，只是没用在「送去后端的蒙版」上）。

## 3. 「上下文」是个可调参数，并且要把尺寸报给用户

`docs/ai-generation.md:304-309`：

> **Context** (Advanced) is how much of the layer around the selection the model is shown, as a
> share of the selection's longer edge on every side (25% by default) … The panel shows the sizes
> (`Selection and context 720 × 760 px → 992 × 1040 px`).

**待改进**。我们是整图送后端，尺寸完全不受控，也从不告诉用户实际送了多大一块。
C-Shop 用的是另一种解法（围绕洞裁一块，外扩 0.5 倍）。两边都在说同一件事：
**整图缩放到模型尺寸会让重绘变成糊影**。

落地建议：`command` 后端加可选 `crop: { context: 0.25 }`，把 (源图, 蒙版) 裁到选区外扩后的大小再交给命令，
并在回执里写 `Selection 720×760 → 992×1040`，让用户看得见。

## 4. 「按钮变灰」要说清是哪一条前置条件

`docs/control-protocol.md:125`：每个命令都带 `enabled` / `disabledReason` / `needsDocument`，
`disabledReason` 举例 `"no document open"`、`"no selection"`、`"the clipboard is empty"`；
未知命令还会给最多三个近似名 `` unknown command `engine.commands`; did you mean `command.list`? ``。

`docs/ai-generation.md:276-279` 对 inpaint 写得更细：

> Both are needed: without a selection, or **on a layer that is empty there** or is not pixels
> (type, shape, adjustment, group), Generate is off and the panel says which.

**待改进**。我们现在只回一句「局部重绘需要：选中带源图绑定的蒙版层，或选中图片层并保持选区」，
而且**没有检查选区那块是不是空的**——在文字层上选区照样会提交，白跑一次生成。

落地建议（并进原计划的 P0-2）：
- `read_state` 增加 `inpaintReadiness: { ready, reason }`，`reason ∈ no-source-layer / no-selection /
  empty-region / layer-not-pixels / provider-lacks-inpaint`；
- 未知命令返回带 `suggestion` 的近似名（我们白名单只有 18 条，代价很低）。

## 5. 路径类命令被"能力范围"挡掉，而不是"可信就不管"

`docs/control-protocol.md:194`：

> Commands that read or write files by path … are refused with "automation command `…` uses ambient
> filesystem paths and is disabled; use capability-scoped document methods".

**已对齐（且需要写清区别）**。我们 0.19.0 新增的 `command` 后端确实会执行带路径的命令，
但命令**来自操作者的插件配置**，不接受模型传入；模型只能传 prompt/图片/蒙版。
这个区别要在 README 里写明，否则以后有人把 `command` 做成可被模型指定的字段就破防了。

## 6. 文字排版：他们是完整 Photoshop 级（点/段落/区域/CJK）

`crates/text/src/area.rs:1` 是「沿闭合路径内部换行」的区域文字；`layout.rs` 用 parley 做字形排版，
`glyphs.rs:121` 先 `layout(...)` 再取 `bounds()` 测量。

**不采纳**（超出我们需要的范围），但**验证了 P0-1 的做法**：测量 = 先排版再取包围盒，
而不是自己用字符数乘平均字宽估。我们对应物就是 `ctx.measureText` + 真实字体加载后取宽度。

对 P0-1 的补充：长文案要么**收缩字号**、要么**按槽宽换行**。他们两者都支持；
我们当前连测量都没有，实现时至少要把「实际用了多大字号」回给调用方。

## 7. 后台任务可取消，且取消后文档不变

`docs/control-protocol.md:255`：长命令走 `wait:false` + `jobs.list` / `jobs.cancel`，
取消或失败的作业**不改文档**；而已经进入"替换文件"阶段的保存不可取消，并如实列在 `notCancelled` 里。

**待改进（低优先）**。我们的生成/重绘只有轮询、没有取消；`INPAINT_TIMEOUT` 会杀掉本地进程，
但服务端作业还在跑。可加 `POST /inpaint/{id}/cancel`，语义照抄这条：取消后不改画布。

## 对计划的影响

| 原计划项 | 本次学习的调整 |
|---|---|
| P0-1 文字先量再画 | 确认「排版后取包围盒」是对的；补一条：回执必须写实际字号；长文案策略（收缩/换行）仍需你定 |
| P0-2 规范化确认卡片 | 扩大为「就绪度 + 解析后的目标」：`inpaintReadiness`（含 empty-region 检查）+ 未知命令给近似名 |
| P0-3 失败两次熔断 | 不变 |
| P1 套版保真 | 新增两项：**送后端的蒙版羽化**、**context 裁剪 + 尺寸回执** |
| P1 混合模式 | 不变（本次未找到他们 blend 的公开说明，不臆测） |
| P2 批量可配 | 不变 |
| —（新）P2-3 | 重绘作业取消语义（低优先） |

不采纳：完整排版引擎（点/段落/区域文字）、路径级自动化命令全禁（我们是操作者配置而非模型传入）。

## 参考位置

| 主题 | 位置 |
|---|---|
| 重绘产物形态 / 蒙版羽化 / context | `layershop-main/docs/ai-generation.md:271-356` |
| 命令就绪度与近似名 | `layershop-main/docs/control-protocol.md:118-251` |
| 路径命令的收敛规则 | `layershop-main/docs/control-protocol.md:194` |
| 后台作业与取消 | `layershop-main/docs/control-protocol.md:253-255` |
| 文字排版与测量 | `layershop-main/crates/text/src/{layout.rs,glyphs.rs,area.rs}` |
