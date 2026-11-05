# dsh-media-image

DSH Host plugin: shared image editing tools plus the packaged miniPaint page.

独立包：只注册图片入口（`dsh-media-image`），路由前缀 `/media-image`，
工具表只含 `media_image_*`。与另一个编辑器包互不依赖，可单独安装。

## 测试

```bash
node --test test/*.test.mjs
```
