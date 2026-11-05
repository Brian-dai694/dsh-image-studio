# DSH 原生会话 Remote 与插件安装入口核查

核查：2026-11-04 ODE。只读静态证据，不等于真实聊天闭环验收。

## 核查目标

文件：`C:/Users/UEFR/AppData/Local/Temp/bundle-big.js`
SHA256：`FE9153F2C334BE7584B5AC89DA33F2895A82B5C0C41E8B2CBA4B867718747559`
这是此前获取的客户端组合产物；本轮未重新获取，不能据此证明当前生产已加载相同产物。

## Remote 契约

- ev_chat_follow_call，L111602：原生调用 `for await (const frame of remote.follow({address:sessionAddress}, signal))`。第二参数是 AbortSignal，返回 AsyncIterable；流可能抛 carrier failure。L111578 明确 follow 可能激活 prepared Session。
- ev_chat_follow_schema，L133559：请求 `{address:{kind:'session',sessionId}, assistantStream?:true, maxMessages?,turnWindow?:{minMessages,minTurns}}`。也支持 subagent address。
- ev_chat_frames，L133581：`event` 带 `event:{type,seq,time,data,...}`；`snapshot` 带 header.id/cursor/records/hasMore/projections/assistantStream?。records 是 `{type:'event',event:...}`，不是裸消息。
- ev_chat_live，L133857：`assistant-stream` 带 frame：start(attemptId,revision,startedAfterSeq,turn,step)、chunk(attemptId,revision,index,time,chunk)、end(attemptId,revision,index,outcome)。outcome 为 committed(eventType,seq) 或 abandoned。
- ev_chat_prompt，L134363：prompt body `{requestId,sessionId,mode:'queue'|'steer',content:[{type:'text',text}|image|file],clientTimeZone?}`。
- ev_chat_prompt_result，L134391：value 为 `{accepted:true}`，仅表示接受提交，不表示模型回复或编辑成功。
- ev_chat_history，L84140：assistant 持久回复正文在 event.data.message.content；需要检查 surfaceOp，不能把所有历史事件都直接追加。

前端应固定 editorKind/projectId/pageId/sessionId 四元组；未找到宿主自动将 Session 绑定到编辑工程的证据。main 槽本身无 Session 绑定，禁止猜测全局当前 Session。切换或卸载 abort 旧订阅并用 generation 忽略迟到结果；按 seq、attemptId/index 去重；提交到持久事件时替换临时流内容。发送失败或结果未知不能自动变参重发。

## 官方插件管理器

- ev_plugins_navigation，L54381：PANEL_ID='plugins'。
- ev_plugins_slot，L54443：注册 main key=plugins；L54494 注册 sidebar.panellist id=plugins。因此官方入口是独立插件面板，并非必须经设置壳。
- ev_plugins_remote，L52064：`ctx.remote.pluginManager.inspect(spec,{registry},signal)`。
- ev_plugins_install，L52121：`ctx.remote.pluginManager.installBundle(spec,{enabled:false,requestId,registry,approvedBuilds?})`。
- ev_plugins_recovery，L52141：结果丢失用 waitForInstall(requestId)，不直接重装。

本轮没有调用生产 installBundle，没有代替用户批准构建脚本或启用插件。该静态调用证据不证明本地 tgz 输入已被运行时接受。

## 当前交接

前端独占 client/UI 文件，ODE 未修改。已将上述准确流契约、取消方式及禁止猜测 current session 的风险发送给前端。待前端交付后进行隔离打包部署，再交 FDE 浏览器实测。当前尚无本轮新版本的真实发送、真实回复、对应工程工具修改与撤销证据。
