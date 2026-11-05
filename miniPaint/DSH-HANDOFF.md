# miniPaint 客户端交接

## 12:10 图标辅助标签补交（页面未操作）

- gui-tools.js：图标 img 加入 trn；图标按钮容器移除 trn，避免原翻译库写 innerHTML 时替换子 img、导致翻译作用于已脱离文档的旧节点；按钮 title 使用现有 translate_message(k)。其他按钮保持原路径。
- zh.json：补 Underline/Strikethrough 及 lowercase title 键；Bold/Italic 两套键沿用已有中文。
- client-regression.test.cjs：8/8，其中新增真实 GUI show_action_attributes + 原 jquery.translate 实现、窄 DOM stub 的重复翻译测试，断言四个仍挂载图标的 alt 与按钮 title 为中文；非浏览器验证。用原 gui-tools 备份反证时 6 通过/2 失败、exit 1，当前版本 8/8。
- bridge.test.cjs 10/10；gui-tools.js 语法 exit 0；最终生产构建 exit 0、3 项既有体积警告。
- 最新 dist/bundle.js：1,377,513 字节；SHA-256 `0A38410C679C0127E6DB8E5C7636984C3643D19B6BEE561AA9AB08212577C822`。本轮备份后缀 `.bak-20261103-120651`。
- 没有操作浏览器、Host、relay、服务或 profile；四个图标的真实页面辅助标签仍交 FDE 复验。未改撤销或保存导出链路。


## 11:49 限定修复补交（浏览器复验未执行）

- 修改 `src/js/core/base-state.js`：公开 `undo()/redo()` 返回队列 Promise；undo 完整成功后才移动 history index，失败时不假称历史已退一步；undo/redo 完成后使用原生 `Base_layers.render()` 请求刷新（不创建第二条 RAF 渲染循环）。
- 修改 `src/js/core/components/number-input.js`：Increase/Decrease 的既有 sr_only 标签加入 trn，进入现有翻译路径。
- 修改 `src/js/languages/zh.json`：补 Stroke/Stroke:、bold/italic、Bold/Italic、Desaturate 共 7 个实际动态键。未全局重写文案。
- 新增 `client-regression.test.cjs`：修复前 6/6 失败，修复后 6/6 通过，涵盖公开入口可等待、undo 失败指针不变、完成后刷新请求和指定翻译覆盖。`bridge.test.cjs` 的文字撤销/重做用例改为调用公开 undo()/redo()，整组 10/10 通过。
- node --check：base-state.js、number-input.js 均 exit 0。npm run build：exit 0，webpack 5.106.2、3 项包体积警告。
- 新 bundle：`dist/bundle.js`，1,377,334 字节，SHA-256 `95B3C362F5F09B2BD6739F8FD31CFC01AFCDDBF7B6A9B0A8128F9598B8F836A4`。备份后缀 `.bak-20261103-114549`。
- audit-zh.cjs：550 字典键、324 字面引用；剩余 X/Y、D/R 与 HTML 方向/空格实体。动态 UI 全覆盖仍未证明。
- 边界：本轮验证是 Node 原生 State/action/bridge + 渲染请求 stub 和翻译源码检查；没有操作浏览器/Host/relay/服务/profile。FDE 之前的“revision 变化、画面文字未恢复”尚不能确定只由以上缺陷造成，不能据此宣称视觉撤销通过。
- FDE targeted recheck：刷新编辑器加载此 hash；人工文字 A 后结束输入，读取 A；桥接改为 B 并回读 B；通过菜单“编辑→撤销”（不要先点击文字或切换工具以免新增 select/activate 历史）回读 A 并截图；“重做”回读 B 并截图；再独立验证画布焦点下 Ctrl+Z/Ctrl+Y。若 refocus/选中操作插入了一条历史，应先识别该历史，不能把 revision+1 当作文字撤销成功证据。
- 保存/导出仅源码核对：save.js 存在 canvas.toBlob→file-saver 的 PNG/JPEG 分支与 JSON 工程保存分支；open.js load_json await 原生 open_json_file bundle。未获得下载文件、重开或图像解码证据，所以未验原因仍是文件闭环证据缺失，不是已证实源码故障。本轮没有修改这些路径。


2026-11-03。仅隔离原型，未修改已安装 profile、宿主配置或流程图数据。

## 来源与构建

- 用户提供 `C:\Users\UEFR\Downloads\miniPaint-master.zip`，326 个归档条目。
- ZIP SHA-256：`EDA7596CA485D2A7E3F8AA2DA5CFFB657B2F6F698680FBDB6A854E71D45A2A1B`。
- `package.json` 为 4.14.3；原始 package-lock 顶层为 4.14.2，两者存在上游版本不一致。源码 commit unknown：ZIP 不是 Git checkout。
- 未改依赖清单或锁文件。锁文件 SHA-256：`33D7954CC5FAC05702D1120FB197B764B2E73F9FAA71396BD84E9A2A09CD0D21`。
- hermite-resize 锁定 Git commit `fae53290d2b03520a6fc81d734c3028902a599c0`。
- `npm ci --ignore-scripts --no-audit --no-fund` 成功安装 517 包；首次 workspace-write 因工作区外 npm 缓存被拒，原命令获更宽权限重试后 exit 0。
- `npm run build` exit 0。webpack 5.106.2；dist/bundle.js 约 1.31 MiB；3 个 bundle 体积建议警告。

## 文件范围

- src/js/main.js：移除重复 bridge import，只初始化一次，GUI/Layers 启动后再暴露握手。
- src/js/dsh-editor-bridge.js：真实状态、命令和原生历史适配。唯一队列包装 State.do_action / undo_action / redo_action / scrap_last_action；idle 人工动作同步起跑，保留 miniPaint 现有调用方立即读取 config.layer 的语义。Agent 在该队列内校验 live revision，并直接调用保存的原生 do_action，避免重入和双增。
- src/js/config.js、index.html：默认 zh / zh-CN。
- src/js/core/base-gui.js：即使无语言 cookie 也执行整页翻译。
- src/js/modules/tools/translate.js、src/js/languages/zh.json：中文通知入口和缺失错误词条；保留原有 DOM i18n。
- bridge.test.cjs：10 项单进程回归，使用真实 bridge、原生 State 方法和 action 实现；DOM/GUI stub。
- audit-zh.cjs：定界静态扫描，不代表完整 UI 文案覆盖率。

## 协议

与 contracts/editor-bridge.v1.json 一致：同源 parent postMessage({type:'dsh.editor.connect',requestId},origin,[port])；MessageChannel 回应 `{requestId,ok,result|error}`。

支持 editor.read_state / editor.apply_command / editor.get_command_result。五个白名单命令采用 `{type,payload}`。新增文字样式仅允许 size、family、fill_color、bold、italic。文字写入 miniPaint 实际的 layer.data 行/片段结构，update_text 保留首片段样式并替换全文。

人工 pointer gesture、IME 或输入框聚焦期间，Agent 写入以现有 EDITOR_NOT_READY 返回中文忙碌提示，不新增契约错误码。原生 do/undo/redo 提交一次 revision 增加一次；无变化的可见性/重排命令不新增历史。新建/打开工程的原生提交切换 documentId。revision 保持实例内单调。

命令结果缓存属于 editor 实例；已应用幂等返回原结果、已拒绝包含 originalResult:null；原生执行异常或 aborted 时不假定完整回滚，保留 unknown，禁止重复 commandId 重放。缓存达 10000 条后拒绝新写入，不逐出旧结果。页面销毁后缓存不持久化。

## 已执行验证

- node --check：main.js / dsh-editor-bridge.js / modules/tools/translate.js 均 exit 0。
- node bridge.test.cjs：10/10，包括真实文字数据、一条原生历史、人工 undo/redo、幂等与 rejected 形状、人工异步先提交后 Agent 旧版本冲突、忙碌拒绝、直接预览变更检测、重排一次撤销、参数拒绝、原生失败 unknown 不重放、新工程 identity。
- node audit-zh.cjs：543 个字典键，检查 322 个菜单/标记文字/通知字面引用；残余匹配仅 X/Y、D/R 单字符和 HTML 空格/方向符号。扫描未覆盖全部动态生成对话框和运行时文案。
- 最终 npm run build exit 0，3 项体积警告。

## 页面与待验收

ODE 隔离服务父页 `http://127.0.0.1:59239/`，编辑器 `/editor/`，静态根映射当前目录；dist 替换后无需服务重启，需刷新现有页面。

客户端负责人未占用共享浏览器。真实页面/UI 行为、中文菜单/工具/对话框/错误截图、文字焦点退出、快速拖拽与异步动作交错、保存重开、PNG/JPEG、离线外链仍未验收。先由架构师只读评审，再交 FDE 独占浏览器。父页面 registry 为 Node 局部模拟，不能称真实 DSH 工具注册/调用链已通过。
