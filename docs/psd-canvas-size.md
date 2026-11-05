# PSD 导入的尺寸判据（判据甲，2026-11-05 定案）

## 一句话

**PSD 导入后画布尺寸是否正确的唯一判据是文档尺寸**：`read_state.canvas` == `AppConfig.WIDTH/HEIGHT` == PSD 文件里的 `width/height`。
`#canvas_minipaint` 这个 **DOM 元素的像素宽度不是判据**：miniPaint 本来就不会让画布画得比容器宽。

## 文档尺寸怎么落地

`src/js/dsh-psd-import.js` 的 `importPsd()` 在落层之后，如果 PSD 尺寸与当前 `config` 不同，追加两条原生动作：

1. `new app.Actions.Update_config_action({ WIDTH: psd.width, HEIGHT: psd.height })` —— 显式写入文档尺寸，宽高一起写、精确等于 PSD；
2. `new app.Actions.Prepare_canvas_action('do')` —— `Update_config_action` 只写 config，画布重排由这条动作完成。

两条动作都包在同一个 `Bundle_action('open_psd', …)` 里，所以：**一次撤销即整体回退**，revision 只 +1，和人手操作共用同一条原生历史栈。

### 为什么不用 `Autoresize_canvas_action`

`src/js/actions/autoresize-canvas.js` 的语义是「让画布刚好装下所有图层」，而且：

- **宽、高分别判断**（宽度不够就扩宽、高度不够就扩高，互不联动）；
- **只放大、不缩小**（已有画布比内容大时不动）。

在已有画布上导入 PSD，就会得到「宽按 PSD、高按旧画布」的混合尺寸——`multiple-strokes-test.psd`（857×448）在 800×600 画布上导入时实测就是 618×437 / 618×323 这类不一致的结果。因此 PSD 导入必须走向上第一条的显式写入路径。

## DOM 元素宽度为什么会被裁

`src/js/core/base-gui.js` 的 `prepare_canvas()`（第 239–254 行）：

```js
var w = Math.min(Math.ceil(config.WIDTH  * config.ZOOM), page_w);   // page_w = #main_wrapper.clientWidth
var h = Math.min(Math.ceil(config.HEIGHT * config.ZOOM), page_h);
canvas.width = w;
canvas.height = h;
```

即元素宽度 = `min(ceil(文档宽 × ZOOM), 容器宽)`。ZOOM=1 时就是 `min(文档宽, 容器宽)`。

同一份新包、`multiple-strokes-test.psd`（857×448）、前缀路由实测：

| 视口宽 | `#main_wrapper` 宽 | canvas 元素 | `AppConfig` / `read_state.canvas` |
|---|---|---|---|
| 700 | 700 | 700×448 | **857×448** |
| 900 | 645 | 645×448 | **857×448** |
| 1200 | 945 | 857×448 | **857×448** |
| 1440 | 1185 | 857×448 | **857×448** |

规律：文档尺寸恒为 857×448；元素宽度只是被容器封顶。宽视口（容器 ≥ 857）下元素也是 857×448。

**这是 miniPaint 的既有行为，不是我们引入的，也不作为缺陷处理。** 要「任何视口都按文档尺寸绘制并出滚动条」必须改上游 `prepare_canvas` 与整体布局，收益低、风险高（会改动编辑器所有页面的初始布局），已明确不做。

## 断言（`miniPaint/psd-canvas-size.test.cjs`）

测试把这条判据固化成三条守卫，改坏了会直接失败：

1. `base-gui.js` 仍是 `Math.min(Math.ceil(config.<W> * config.ZOOM), page_<w>)` 这一口径（上游若改公式，我们必须重新评估判据）；
2. 四视口下元素期望宽度 = `min(857, 容器宽)` = **700 / 645 / 857 / 857**，且**文档尺寸恒为 857×448**；
3. `dsh-psd-import.js` 仍通过 `Update_config_action({WIDTH, HEIGHT})` + `Prepare_canvas_action('do')` 写入尺寸，**没有退回 `Autoresize_canvas_action`**。

运行：

```bash
cd dsh-image-studio/miniPaint
node psd-canvas-size.test.cjs
```

## 换包后的人工复验口径

- 用 `read_state.canvas` 读文档尺寸，`multiple-strokes-test.psd` 必须是 **857×448**，700/900/1200/1440 四个视口都一样；
- 另外四个样本：`test` / `text-test` / `vector-test` → 200×200，`timeline` → 300×275；
- canvas 元素在窄视口被裁窄属预期，**不算失败**；
- 文字层仍是可编辑文本（`a`、`b`）。
