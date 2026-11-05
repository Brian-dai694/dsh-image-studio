# 图片图层命令契约 v1（2026-11-05）

适用于 `dsh-media-image` Host 工具 `media_image_apply_command`。Host 只做**形状与取值域**校验；
文档状态（图层、素材、像素快照）唯一由 miniPaint 页面持有，Host 不缓存、不转存像素。

## 1. 本轮新增命令

| 命令 | 风险 | 说明 |
| --- | --- | --- |
| `layer.add_image` | 高风险，需人工审批 | 把素材放进画布，保留 alpha，一步一个 revision |
| `layer.set_frame` | 低风险 | 像素框定位；模型给坐标而不是缩放比 |
| `layer.feather` | 低风险 | 只改该图层 alpha，不新建图层 |
| `layer.color_match` | 低风险 | Lab 均值/方差（Reinhard）迁移，幂等 |

`layer.drop_shadow` **不在本轮白名单**，调用返回 `UNSUPPORTED_COMMAND`。它需要改渲染管线，单独立项。

## 2. 字段

### `layer.add_image`（审批）

```js
{
  sourceRef: string,                 // 必填，见 §3
  x?, y?: int,                       // -16384..16384，缺省按 fit 放置
  width?, height?: int,              // 1..16384，必须成对；都不给=保留源尺寸
  fit?: 'stretch'|'contain'|'cover', // 默认 contain
  name?: string                      // ≤120 字符
}
```

回执：`{ layerId, frame:{x,y,width,height}, hasAlpha, revision, stateDigest, afterDigest }`。
`hasAlpha` 必须如实反映源图是否带透明通道——后续羽化与调色都依赖它。

### `layer.set_frame`

```js
{ layerId, x?, y?, width?, height?, fit?, anchor?: 'top-left'|'center' }
```

至少给一项；`width`/`height` 必须成对出现（或都不给）。**只给一边时，由图层原比例推算另一边**
（这是 `set_transform` 表达不了的像素框语义）。`anchor:'center'` 时 `x/y` 视为中心点。

### `layer.feather`

```js
{ layerId, radiusPx: int }          // 1..64
```

只改变 alpha，不改变 RGB、不新建图层。写回走原生图层动作，因此可撤销。

### `layer.color_match`

```js
{
  layerId,
  method: 'reinhard',               // 当前仅此一种
  strength?: number,                // 0..1，默认 1
  reference?: 'canvas'|'below'|{ x,y,width,height }   // rect 四项齐全
}
```

## 3. `sourceRef` 的三种合法形态

| 形态 | 含义 | Host 校验 |
| --- | --- | --- |
| `asset:<id>` | 文档素材表里的素材（用户导入文件/粘贴/PSD 图层时由编辑器登记） | 非空、≤256 字符；**存在性由编辑器判定** |
| `layer:<layerId>` | 复制一个已有图层的像素（Agent 可以再放一份） | 同上 |
| `data:image/(png\|jpeg\|webp);base64,...` | 受限内联图 | MIME 白名单 + **解码后 ≤256 KB**，超限拒绝 |

像素永不进入模型上下文：`read_state` 的素材只给 `{id,name,width,height,bytes,mime}`。
大于 256 KB 的图必须走编辑器导入，不能塞进工具参数。

## 4. `read_state` 新增字段（均为可选，缺省=未应用）

```js
layers[i].sourceRef?    // asset:<id> / layer:<id> / 内联图来源
layers[i].frame?        // {x,y,width,height}
layers[i].hasAlpha?     // boolean
layers[i].maskSource?   // 'alpha' | 'rect'（羽化/调色用的 mask 来源）
layers[i].feather?      // { radiusPx, fromDigest }
layers[i].colorMatch?   // { method:'reinhard', strength, fromDigest }
assets[]                // [{ id, name, width, height, bytes, mime }]
```

只在应用过时出现，**不要返回 `applied:false` 之类噪音**，Host 校验也不要求这些字段存在。

## 5. 幂等与快照（编辑器内部）

- 编辑器按 `layerId` 保存 `Map<layerId, { base: ImageData, digest }>`，`base` 是**首次编辑前**的像素。
- `feather` / `color_match` 可**重复调用**，但每次都从 `base` 重算，新参数覆盖旧值，不允许在上次结果上叠加。
- 来回调参必须幂等：先 radius=2 再 radius=8，结果等于直接用 radius=8 算一次；调 `strength` 同理。
- 快照与 `base` **不写图层字段、不进 read_state、不进模型上下文**；`fromDigest` 只是溯源用的 `fnv1a64-…` 摘要。
- Host 不实现"只能应用一次"的拒绝逻辑：它不是累积操作，也不是一次性操作。

## 6. 撤销与 revision

- 每条成功命令 `revision + 1`，写一条原生历史；沿用 `history.undo {targetCommandId, afterDigest}`，
  仅当仍是栈顶且 digest 匹配时允许，否则 `HISTORY_CONFLICT`。
- **不做宏命令**：Agent 一次「把图放进去并调和谐」= 多条命令、多次 revision、多个可撤销步骤。

## 7. 校验边界（谁负责什么）

| 检查 | Host | 编辑器 |
| --- | --- | --- |
| 命令在白名单内 | ✅ | — |
| 字段名与类型、取值域 | ✅ | — |
| `sourceRef` 形态与内联体积 | ✅ | — |
| 素材 id / 图层 id 是否存在 | ❌ | ✅ |
| revision/expectedRevision 冲突 | 前置比较 | ✅ 权威 |
| alpha 保留、mask 来源 | ❌ | ✅ |
| 快照与幂等 | ❌ | ✅ |

版本：**v1**。文件：`docs/layer-commands-v1.md`（图片仓库）。
任何字段增删或语义调整都要升版本，并同步 Host 校验与回归。
