# DSH 图片编辑器（人机协作）

DSH（DeepSeek Harness）里左侧原生图片编辑器、右侧真实会话的人工 + Agent 协作编辑：人和 Agent 改同一份工程状态，可撤销、可回读、旧版本写入会被拒绝。

本仓库是**图片侧独立仓库**，视频侧见 [dsh-video-studio](https://github.com/Brian-dai694/dsh-video-studio)。

## 目录

| 路径 | 内容 |
| --- | --- |
| `miniPaint/` | miniPaint 底座源码（中文界面、Apple 主题、原生历史桥、PNG/JPEG 导出） |
| `host/` | 图片宿主页 `host.html`、`host.js`，同源 iframe transport，图片页打包脚本 |
| `contracts/` | `editor-bridge.v1` 命令/状态契约、DSH 会话接口核查记录 |

## 协作约定

- 状态由编辑器唯一持有；Host 只做白名单命令、`expectedRevision`、`commandId` 防重与审计。
- 写入后立即回读校验；结果未知记 `unknown` 并禁止重放。
- 定向撤销需 `commandId + afterDigest + revision + 历史栈顶` 全部匹配，否则 `HISTORY_CONFLICT`；空历史返回 `HISTORY_EMPTY`。
- 首次绑定走宿主原生审批（`allowed-once`），审批前后页面与工程快照必须一致，客户端自报会话 id 不参与授权。

## 构建

```bash
cd miniPaint && npm install && npm run build
node host/pack-image.mjs   # 生成 public/image 下的图片页产物
```

## 状态

已实测：绑定登记、写入 R+1 与回读一致、定向撤销、旧凭据冲突、空历史、过期 revision 拒绝。
待验收：PNG/JPEG 实际下载打开、工程保存重开、极简布局。
