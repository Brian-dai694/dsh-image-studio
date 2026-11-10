# 接上 ComfyUI 做真实局部重绘（inpaint）

> 结论先说：**Provider 代码、注入点、上传/轮询/取图链路、素材落库都已实现并有测试**（`lib/generation.js`
> 的 `createComfyUiProvider` + `presets/comfyui-inpaint-sd15.json` + `test/comfyui-preset.test.mjs`）。
> 缺的只是**这台机器上没有配置一个真实后端**。所以现在 `GET /media-image/inpaint` 仍然如实报「没有 inpaint 后端」——
> 这正是设计上想要的：缺后端就说缺后端，不假装能生成。

本文把"接入"压缩成一次配置，而不是"你先去写一份 ComfyUI 工作流"。

---

## 1. 前置

1. 本机跑起 ComfyUI（默认 `http://127.0.0.1:8188`），并且能在它的 Web 界面里跑通一次 inpaint。
2. 有一个**可用的 inpaint 模型**。两种都可以：
   - 专用 inpaint 模型（如 SD1.5 Inpainting，文件名类似 `v1-5-inpainting.ckpt`）—— 推荐；
   - 普通文生图模型 —— 也能跑（节点用的是 `VAEEncodeForInpaint`），但边缘质量通常差一截。
3. 打开 ComfyUI 的 **API 格式**导出（`Workflow → Export (API)`），你看到的是 `{"<id>": {"class_type":…, "inputs":…}}` 这种结构。
   注意：**不是** UI 格式（那个带 `nodes`/`links` 数组），我们的 provider 只吃 API 格式。

## 2. 配置（复制即可）

插件 `config` 里加一段（也可以走环境变量 `DSH_MEDIA_IMAGE_PROVIDERS`，值是同样的数组 JSON）：

```jsonc
{
  "generation": {
    "providers": [
      {
        "id": "comfy-local",
        "kind": "comfyui",
        "baseUrl": "http://127.0.0.1:8188",
        "workflow": { /* 粘贴 presets/comfyui-inpaint-sd15.json 的整个对象 */ },
        "promptNode":    { "nodeId": "6",  "field": "text"  },
        "editImageNode": { "nodeId": "10", "field": "image" },
        "editMaskNode":  { "nodeId": "11", "field": "image" }
      }
    ]
  }
}
```

三个注入点都必须给，`inpaint` 能力才会被声明为 `true`（只给其中一部分 = 明说"这个 workflow 不做 inpaint"，
`startInpaint` 会直接拒绝，而不是偷偷退化成文生图）。这对应 `capabilities.inpaint: !!(editImageNode && editMaskNode)`。

初始化时 `index.js` 会打印每个 provider 的能力摘要；没有 `generation.providers` 时一条都不注册，
`/generate` 与 `/inpaint` 都返回 `PROVIDER_UNAVAILABLE`。

### 换模型 / 换档位

只改 `workflow` 里对应节点的字段：

| 想改的东西 | 改哪个节点 |
|---|---|
| 模型 | `"4".inputs.ckpt_name`（**必须是你机器上真实存在的文件名**） |
| 步数 / CFG / 采样器 | `"3".inputs.steps / cfg / sampler_name / scheduler` |
| 反向提示词 | `"7".inputs.text` |
| 蒙版外扩 | `"12".inputs.grow_mask_by` |
| 输出前缀 | `"9".inputs.filename_prefix` |

> `ckpt_name` 写错是第一次接入最常见的失败：ComfyUI 会在 `/prompt` 阶段返回 400 并带一段校验错误，
> 我们的 provider 会把它当 `GENERATION_FAILED` 抛出，不会装作成功。先照 ComfyUI 启动日志里的实际文件名填。

## 3. 蒙版约定（这条最容易搞反，而且两条输入路径的极性相反）

编辑器有两条产生蒙版的路径，它们写进 PNG 的方式**不一样**，所以同一份节点接线不可能同时喂对两者：

| 来源 | PNG 里"要重绘的区域"在哪 | `ImageToMask` 应该读哪个通道 |
|---|---|---|
| **选区**（`editor.export_inpaint_inputs` 无 `maskLayerId`） | 黑底 + 白矩形 → **红色通道 255** = 重绘 | `channel: "red"`（预设就是这条） |
| **绑定蒙版层**（`maskLayerId`） | 白色 RGB 恒定不变，区域在**alpha**（透明=挖掉） | `channel: "alpha"`，且语义是"不透明=重绘" |

预设 `presets/comfyui-inpaint-sd15.json` 是按**选区**那条写的。如果你主要用蒙版层做重绘，
把 `"13".inputs.channel` 从 `"red"` 改成 `"alpha"`；想两条都支持，就各配一个 provider
（`id` 不同、`editMaskNode`/通道不同），按场景选——比让一个 workflow 猜来源可靠。

判断有没有搞反，看结果而不是猜：**选区被改了、别处没动** = 对；**整张图都变了** = 极性反了；
**什么都没变** = 反了，或者蒙版全黑。别靠调提示词糊过去。

- 我们的 provider 把源图和蒙版**分别上传**到 ComfyUI 的 `/upload/image`（`type=input`），
  再把返回的文件名注入 `editImageNode` / `editMaskNode`。它不解释蒙版内容，极性由 `workflow` 决定。
- 选区路径带 1/8 羽化（`blurAlpha`），所以边缘是渐变的，接缝不会硬；蒙版层路径的羽化由你自己的蒙版层决定。

## 4. 验证链路（不要跳过）

```bash
# ① 能力：应该看到 inpaint: true 且列出你的 provider id
curl -s http://127.0.0.1:56645/media-image/inpaint | jq

# ② 真跑一次：先用编辑器选一块区域，再让 Agent 调 media_image_apply_command
#    （inpaint 结果是一个新素材 asset:<id>，不会自己改画布）
```

验收标准，按顺序卡：
1. `/inpaint` 的 `providers[].capabilities.inpaint` 为 `true`；
2. 提交返回 `jobId`，轮询从 `running` 走到 `succeeded`；
3. 回执里 `artifactRef` 是 `asset:<48位>`；
4. 把它 `layer.add_image` 落层后**只用原图那块区域的像素变了**（用 `analyze` 或预览核对）。

任何一步是 `unknown` 就**只查不重放**（轮询会保留 `remoteId`），别换 `commandId` 重来。

## 5. 诚实边界

- 本机**没有**跑过真实 ComfyUI：`test/comfyui-preset.test.mjs` 用桩 `fetch` 验证了
  「上传 → 注入节点 → `/prompt` → `/history` → `/view` → 素材落库」这条链路，
  但**没有**验证某个具体模型的实际出图质量。质量取决于你选的模型与参数，不作承诺。
- 预设里 `ckpt_name` 是示例值，照抄不改大概率报「模型不存在」。
- 走 GPU 的显存、时长、并发都不由本插件管理；后端排队慢只会表现为轮询时间变长。
- 云端 provider（`kind: "http-json"`）与本地命令行后端（`kind: "command"`）是另外两条路，见 `lib/generation.js`
  与 `lib/inpaint-command.js`；三者的 `capabilities` 都如实声明，不互相冒充。
