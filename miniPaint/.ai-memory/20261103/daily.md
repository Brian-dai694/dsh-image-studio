# 2026-11-03 客户端限定修复日志

## 12:10 - Bug 修复：图标辅助标签中文翻译

- 文件：gui-tools.js、zh.json、client-regression.test.cjs，重新构建 bundle；交接已更新。
- 根因：图标 img 不带 trn；父按钮带 trn 时原翻译库重复写 innerHTML，新增 trn 图标仍可能被替换为未翻译的新节点。局部移除图标按钮 trn、给 img 添加 trn，并在按钮 title 调现有 translate_message；补齐下划线/删除线键。
- 验证：原 GUI 备份下同一回归 6 通过/2 失败，当前 8/8；真实 GUI 方法+原翻译函数、DOM stub 重复翻译后四组 alt/title 全中文。桥接 10/10；语法、最终构建 exit 0（3 项体积警告）。bundle 1,377,513 字节，SHA256 0A38410C679C0127E6DB8E5C7636984C3643D19B6BEE561AA9AB08212577C822。
- 边界：无页面/服务/Host/profile 操作，未改撤销或导出；真实页面标签仍待 FDE。备份后缀 .bak-20261103-120651。


## 11:49 - Bug 修复：可等待历史入口、历史游标和刷新请求、确认的中文动态键

- 文件：src/js/core/base-state.js、src/js/core/components/number-input.js、src/js/languages/zh.json、bridge.test.cjs；新增 client-regression.test.cjs；构建 dist/bundle.js；更新 DSH-HANDOFF.md。
- 决策：公开 undo/redo 返回现有共享队列 Promise；undo 成功后移动游标；不创建新 RAF 循环，使用原生 render() 请求。仅补 FDE 确认的英文控件路径，不改变布局。未操作浏览器、Host、中继、服务和生产 profile。
- 验证：新增 6 项用例修复前全失败、修复后 6/6；原桥接 10/10（文字用例改为公开 undo()/redo()）；语法 exit 0；生产构建 exit 0，3 项包体积警告。产物 1,377,334 字节，SHA256 95B3C362F5F09B2BD6739F8FD31CFC01AFCDDBF7B6A9B0A8128F9598B8F836A4。
- 未验证：FDE 的视觉撤销现象根因未完全确认；此轮仅证明 State/action/bridge 和渲染请求。需菜单撤销/重做且不插入选中或工具切换历史进行复验；截图、保存重开、有效 PNG/JPEG、真实 DSH 工具注册仍未通过。
- 回滚：本轮源码和旧 bundle 有 .bak-20261103-114549 副本。源码 ZIP 无 Git 元数据，无分支。未改依赖清单和锁文件。
