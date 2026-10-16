# 架构与明确边界

协议见 [PROTOCOL.md](PROTOCOL.md)；CoS 函数移植的来源与改动见 [vendor/cos/README.md](../vendor/cos/README.md)。

## 1. 两条通道，不混用权限

Paseo Server 入口启动一个共享 Runtime。不同 Provider connections 共用连接服务；一个本地会话只能被一个 connection 持有。Chrome 后台持有配对 token、执行记录和标签页绑定，content script 只操作与观察自己的网页。

消息通道：Paseo → ProviderInput → Broker 持久队列 → Chrome worker 认领 → 网页 → 原生回执/可见回复 → Broker → ProviderEvent。工具通道另为 ChatGPT → 已授权 `@` 应用 → 对应 MCP 主机。本项目不运行 shell、不发布文件 API、不转发 MCP 凭据。

宿主默认的 paseo HTTP 回环 `/mcp/agents` 配置允许被显式排除并显示警告，以免阻塞创建会话；这不意味着导入了该工具。其他 MCP 配置及 toolPolicy 拒绝。网页模型不自动获得 Paseo 内部子 Agent 工具。

## 2. Provider 与设置

支持 catalog、session.open、纯文本 prompt、configure、interrupt、close；协商能力仅为 prompt.message、session.configure、session.persistence。目录 DTO 不传非法 null 默认值；真实插件出口使用官方 SDK EventSchema 验证，未运行该 SDK 的离线测试会明确标记。

SettingsScreen 通过 addSettingsScreen 提供正常入口，使用宿主主题和容器。默认模型/思考值反映到 catalog 和缓存键；应用以逐项 toggle 传递。未启动网页时，配置保存为“待应用”并发出 notice；首次发送才打开页面并确认。已绑定网页的配置变更需读回确认。失效选项报错，不替换为另一个模型。

恢复读取 runtime UUID，实际更新 cwd 和用户级说明，并在下一条消息携带新上下文；没有把这些说明伪装成高优先级系统消息。history=replay 只重放本地历史到 Paseo 界面，不重新发送给模型。

## 3. 发送、停止和未知结果

命令为 queued → claimed → authorized(send) → done/failed。会话为 idle → sending → running → idle；停止经过 stopping；不明结果进入 blocked，人工核查后可结束本地跟踪为 abandoned。

消息 ID 在进入异步动作前保留，Broker 持久记录失败 ID。同 ID不能暗中开新一轮；需要用户显式用新 ID重试。默认至多两个生成中会话；每个会话独立队列，Stop 使用独立派发通道，不等待另一个页面完成。

点击 Send 前，在授权 await 返回后同步核对文档、导航代次、编辑器实例、原始 HTML、结构化正文、模型、思考、应用、消息基线和按钮；最后核对与点击之间不再 await。只有确认没点过才上报 notSent；清理只触及自己完整未改的草稿。缺回执不重放发送。

Stop 的判断与建立由一个存储事务负责，并绑定 turn ID。重复 Stop 共用命令；完成事件也结算待停请求；旧回执不得终结新轮。停止网页并不表示杀死外部 MCP 创建的进程。已认领配置超时和重启后的不明配置均阻断，不凭旧值继续工作。

## 4. 身份与浏览器恢复

Paseo 会话 ID → runtime UUID → 原生 conversation ID → tabId/documentKey → turnId/native user message ID。事件还需匹配当前 lease。错误文档、标签、轮次不得修改另一个会话。

扩展本地存储保留绑定，但是数字 tabId 不是重启后的授权。重新观察唯一对话及原生用户消息锚点后，可以通过 rebind-observation 更新监控，不创建发送。无法证明时明确报告 binding_lost 并阻断该会话；不是静默丢失，也不是保证所有刷新都能恢复。加载中或虚拟化导致锚点暂时不可读，仍可能保守阻断。

回答快照按消息 ID 更新。可读取原版 `turn.messages`/`allMessages` 时，使用 CoS 的公开文本和 `end_turn=true + finished_successfully` 判断；更晚的未完成回答使旧 final 无效。不能读到该模型时，只降级为既有明确 message-ID 和专用 turn action 的 DOM 路径。完成需要本轮 final 证据和稳定窗口；代码块复制按钮不算。授权等待与缺 final 证据分开提示。只输出可见文本和状态，不虚构工具执行证据或隐藏思考过程。

## 5. 存储与安全

同目录临时文件、fsync、rename 后才发布内存；单文件事务串行，坏状态不会自动重置。新消息预留历史片段和回答最坏 JSON 字节；32MiB 状态中保留 128KiB 控制余量。单轮聚合 256,000 字符、16 片段，超限记录终局错误。额外磁盘满、I/O 失败不在这些逻辑预留保证内，仍需操作系统处理。

HTTP 仅回环监听，检查 Host、Origin、extensionId、token、大小和速率。配对码一次性；重配前先核对 CIP 版本，失败不主动覆盖旧配置。密钥和历史未加密，无法防止已经能读取当前用户目录的恶意本机进程。

扩展没有 cookies、debugger 或全站权限。本项目不提供自动批准、文件执行或任意代理端点。网页结果不负责证明外部 MCP 的实际改动。

## 6. 未完成的实机范围

完整 SDK 类型解析、Paseo 安装和设置界面；真实 ChatGPT 菜单、应用与最终状态；Chrome MV3 暂停/恢复及导航竞态；账号切换和分页目录；实际远程 MCP 的只读验证；高并发与大历史性能。

未移植完整 CoS Fiber、Goal/Loop、Compact & Resume、工具审批代理、丰富工具日志、原生子 Agent 调度；不将这些列为本版已实现。存储仍写整份状态，尚无归档删除 UI。离线测试不是生产负载测试或“分布式恰好一次”证明。


## 7. CoS 函数移植边界

十二个活跃模块位于 extension/upstream（逐个来源见 vendor/cos/provenance.json）；本机服务端仍是原有 Paseo 适配 Runtime。CIP v3 将旧扩展隔离，原版 CoS 主程序不会启动。MAIN 世界仅提供已提交状态的只读公开投影，isolated 世界控制原生 UI；页内消息不持有配对 token。来源清单不等于整个 CoS 功能或兼容性的继承。
