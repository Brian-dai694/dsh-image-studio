# 共享视觉规范 v1（图片 / 视频编辑器通用）

> 目的：两个编辑器共用同一套视觉语言，**任何一边都不再自造色值、圆角、间距**。
> 图片侧已按本文件落地（`src/css/apple-theme.css` + `src/js/dsh-minimal-ui.js`）；
> 视频侧由 ODE 套用，取值只能引用本文件的 token。

## 1. 颜色（只允许这三种 + 中性灰阶）

| token | 值 | 用途 |
|---|---|---|
| `--dsh-bg` | `#f5f5f7` | 页面/面板背景（Apple 灰） |
| `--dsh-surface` | `#ffffff` | 卡片、工具条、浮层 |
| `--dsh-ink` | `#1d1d1f` | 主文字 |
| `--dsh-ink-2` | `#6e6e73` | 次要文字、说明 |
| `--dsh-ink-3` | `#86868b` | 占位、禁用文字 |
| `--dsh-accent` | `#0071e3` | **唯一强调色**：主按钮、链接、选中态 |
| `--dsh-line` | `rgba(0,0,0,.08)` | 分隔线 |
| `--dsh-danger` | `#ff3b30` | 错误文字与错误边框 |
| `--dsh-success` | `#1d7a3c` | 成功状态（如 applied） |

规则：
- **不引入第四种彩色**；危险/成功只用于状态文字与细边框，不做大面积填充。
- 不使用渐变背景、玻璃拟态叠层、发光边框。
- 语义色（danger/success）不得当装饰色用。

## 2. 圆角

| token | 值 | 用途 |
|---|---|---|
| `--dsh-r-sm` | `10px` | 输入框、小控件 |
| `--dsh-r-md` | `12px` | 次级按钮、标签 |
| `--dsh-r-lg` | `16px` | 卡片、面板、工具栏 |
| `--dsh-r-full` | `999px` | 主按钮（胶囊） |

## 3. 间距（4 的倍数）

`4 / 8 / 12 / 16 / 24 / 32`。组件内边距用 8–16，面板外边距用 16–24，区块之间用 24–32。
禁止 5、7、9、13 这类零散值。

## 4. 字体与行高

```
font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei", sans-serif;
```

| 档位 | 字号 / 行高 | 用途 |
|---|---|---|
| 标题 | 20 / 1.3 | 面板标题 |
| 正文 | 13 / 1.5 | 消息、正文 |
| 辅助 | 12 / 1.5 | 说明、状态 |
| 微 | 11 / 1.4 | 徽标、修订号 |

等宽（JSON/回执）：`ui-monospace, SFMono-Regular, Menlo, monospace`，12/1.5。**原始 JSON 不得直接出现在对话里**（工具结果用卡片）。

## 5. 按钮三态

- 常态：`background: var(--dsh-bg)`（主按钮为 `--dsh-accent` + 白字），`border: 0`，`border-radius` 按档位，`padding: 10px 16px`。
- hover：背景加深一档（`rgba(0,0,0,.05)` 叠加，主按钮 `#0071e3 → #0077ed`）。
- active：`transform: scale(.98)`（主按钮 `.96`），过渡 `180ms cubic-bezier(.25,.1,.25,1)`。
- 禁用：`opacity: .5`，`cursor: not-allowed`，不做缩放。
- `prefers-reduced-motion: reduce` 时关闭所有过渡与缩放。

## 6. Focus ring

`:focus-visible { outline: 2px solid var(--dsh-accent); outline-offset: 2px; }`
禁止 `outline: none` 后不加替代；键盘可达性必须保留。

## 7. 空状态

- 居中文案，正文 13/1.5，`--dsh-ink-2`；不放大图、不放插画。
- 一句话说清"这里为什么空 + 下一步做什么"，例如「还没有消息。输入指令后由真实会话处理。」

## 8. 状态条与错误提示

- 提示条：`background: var(--dsh-surface)`，`border-radius: var(--dsh-r-md)`，`padding: 8px 12px`，12/1.5。
- 错误：文字 `--dsh-danger`，背景 `#ffeceb`，**必须是一句中文人话**，不出现错误码原文当唯一信息。
- 成功/进行中：只用文字颜色区分，不加彩色底。

## 9. 分区与层级

- 结构顺序固定：顶栏（标题 + 主操作）→ 内容区（画布/时间线）→ 右栏对话。
- 面板之间用 1px `--dsh-line` 分隔，**不用阴影分隔**；浮层/卡片才用 `0 4px 12px rgba(0,0,0,.08)`。
- 顶栏高度 60px；工具条按钮同高 36–40px；不允许出现 0×0 但可点击的控件（必须可见或有等价入口）。

## 10. 语言

界面文案一律简体中文；错误提示给人话；英文仅保留在代码、日志与技术字段名中。

## 11. 落地状态

- 图片侧：`src/css/apple-theme.css` 定义上述变量；极简模式工具栏（导入 / 文字 / 图片 / 导出）按本规范实现，按钮 60×39，带 `aria-label`。
- 视频侧：待 ODE 按本文件替换现有色值与圆角，**不得并行维护第二套 token**。
- 变更本文件需同时改两个仓库的样式，且在提交信息里写明 token 变更。
