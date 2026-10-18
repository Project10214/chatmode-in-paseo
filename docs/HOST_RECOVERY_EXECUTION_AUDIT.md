# 原版宿主恢复生命周期执行审计（离线；未部署）

2026-10-17。此报告纠正“窄模型红例意味着任何同 ID 恢复都不可能”的过度推断。

## 方法与来源

执行公开 npm `@getpaseo/server@0.11.4` 的原版 AgentManager、AgentRunState、PluginAgentClient、ProviderRuntime，接入当前仓库 Provider/Broker；I/O、浏览器命令和状态均为临时合成夹具。不是仅摘出终态 guard 重写模型。未连接真实 daemon、账号或 Agent，未启动模型 CLI，未修改安装宿主。

包完整性已核对：
`sha512-rm7Ultkt+6immOSf24srXt/XHgmZOrfRUD8uBzDeui5pLYj4r5PLciUBdJBZAznC5wq5tuEC2L6gyD673MAi9A==`。

与已安装解包源码一致的 SHA-256：

- agent-manager.js：`5baa385f48c1a06938ab3fcc073f4534fa0b04c1ec4a2c0228e653e929210450`
- agent-run-state.js：`ac8b7ff61bf91350b073858c5ca10dedd1ca99dd2ae40f9f562d4bd26fc29ec0`
- plugin-provider.js：`dc9948ca942d2aeef10a48c4ef1fc625819005ef28296bb386cfb9737502d475`

脚本/结果：`../logs/host-recovery-artifacts/{scripts,out}/`；原实验依赖包在 `/tmp/cip-host-recovery-20261017/`。脚本含该临时实验路径，不是假称可脱离依赖直接复跑的自包含测试。完整 provenance 还记录当时导入的 CIP 源码哈希。

## 真实结果

| 场景 | 原版宿主结果 |
|---|---|
| S1：前台失败后原连接，当前 Provider 的 started/ended 去重保留 | 新正文进入宿主时间线对象；Agent 仍 error，不呈现恢复运行/结束 |
| S1c：在 S1 上请求宿主 Stop | 返回 not_running，未传到 CIP |
| S2/S2b：在同一已结束前台 ID 上强行重发 started | 建立自主运行，terminal 被 finalized 集合丢弃；后续提示报 already has an active run；取消补发同 ID terminal 也被丢弃，10 秒内未返回 |
| S3：网页发起的自主轮次 | 不登记前台 finalized；同 ID 再开始/结束可正常收尾 |
| S4：宿主创建新会话，CIP 在 open 期间宣布 started | 新 finalized 集合为空，但 started 只进入历史；宿主历史装载仅取时间线项，Agent 仍 idle |
| S4b：新会话订阅后宣布 started | 原 turnId 可运行→空闲，下一条提示可接受 |

没有隐藏的 runtime→managed 身份转换可以自动解决 S2。`attachManagedTurnIdentity` 只补充缺失的 turnId；CIP 已带的 ID 原样保留。旧模型遗漏的是前台/自主运行区别、新会话集合重建、open 历史吞生命周期，以及 CIP 自己的去重。

**内容能续接，不等于宿主运行/取消控制已恢复。** 临时宿主时间线对象接到正文，也不证明真实 daemon 数据库落盘或 UI 显示。

## 重载不能当成天然只读恢复

原始 DaemonClient 的 `refreshAgent()` 对应 `refresh_agent_request`（workspace.write），走 interruptAgentIfRunning → reloadAgentSession → hydrateTimelineFromProvider。插件公开 PaseoApi 没有这项 API；AgentRef.refresh 只是 fetchAgent，detach 是解除父子关系，不是卸载。

实际运行 `reloadAgentSession`：

- R1：CIP 已恢复为 running 后重载，产生 **1 条 Stop**，关闭超时，CIP 进入 stopping。Stop 来自当前 Provider `session.close → broker.interrupt`，不是宿主“无 active run”检查能避免的。
- R2：CIP 仍 failed/idle 时先重载，再恢复，**0 Send/0 Stop**；Agent ID、CIP turnId、原历史保留，新宿主会话可正常运行和收尾。初始R2未覆盖后续hydrate；现在REAL-8补了原版reload及hydrate，但仍不是真实daemon操作。

这是明确操作顺序的合成证明，不是对真实现场重载的许可。不得自动套用；尤其不能先恢复成 running 再盲目重载。

## 新会话的订阅屏障

原版 list_commands_request：ensureAgentLoaded → registerSession（最后订阅）→ hydrateTimelineFromProvider → session.listCommands → 回复。实验 C1 验证先注册/订阅，再加载返回，再 commands 返回；此后宣布 started 能正常结束且不 Send/Stop。

现有只读 `wake.mjs` 的 `await agents.ref(id).commands()` 因而可提供**进程内订阅屏障**，但必须另外确认宿主会话确实换过。对一直加载的旧会话，commands 也会立刻返回，并不清除 finalized；不能在此后盲目重发 started。它也不是正文保存回执。候选已接入共享host-observation对象、独立binding请求和有序暂存；未完成跨真实daemon/WebSocket的验证。**它不能证明并发的新prompt尚未进入pending**，见下方新增门禁。

Provider 协议没有“请求重建宿主观察连接”的事件。不能用 session.closed 推测未声明能力，也不能偷偷调用非公开重载代替用户授权。

## 门禁与未解决项

OBS-P2现已通过：正式订阅屏障接线，open返回后的独立成功证明才释放live事件；ready后同一个open handler同步发出的started仍不算订阅证明。OBS-P1仍红：已终结前台轮次的旧连接不能复活；Broker现在提前安全拒绝，不写盘、不占槽、不Send/Stop。

同一已加载前台失败会话，若同时要求原 turnId、正确运行/终态和宿主 Stop，目前没有协议内闭环。需要宿主能力或明确授权的外部会话生命周期处理；**没有采用另造恢复运行 ID 的方案**。

仍未接真实持久存储/registry、多客户端和真实网络，未恢复两个目标原 Agent。不得把本审计当作已可发布。

## 后续完整类门禁（alpha.4.20；含0.12.0-beta.1）

`npm run test:host-recovery`执行`tests/host-observation-real.mjs`，需`CIP_PASEO_SERVER_PACKAGE`指向固定原版包。支持0.11.4和0.12.0-beta.1，按实际包版本选择精确来源并使用其自己的SDK，未知版本/哈希不符明确失败。两版均13项10过3红0skip，日志`../logs/paseo-012-real-{0.11.4,0.12.0-beta.1}.log`。新版实际安装asar核心哈希与npm包一致；见 [新版兼容核查](PASEO_012_COMPATIBILITY.md)。

- REAL1–8通过：原ID新会话恢复、同旧连接拒绝后明确reload、失败/adopt、旧证明隔离、早到正文/终态、真实reload lane与history priming。REAL-7说明commands等待reload lane；此前未经执行的“Map已写入就能提前返回”推断已撤回。
- REAL10/11通过：屏障前的跟踪失败已恢复，不重放过期failed；确证Stop后的半段位于held canceled之前，原ID、不重开。
- **REAL-9两个窗口和REAL-12红**：新prompt pending接管旧正文并错序；新prompt失败则丢弃staged旧正文。订阅成功不能消除此竞态，不能只补flush。详细固定代码链和所需能力见 [HOST_CONCURRENT_DELIVERY_GATE.md](HOST_CONCURRENT_DELIVERY_GATE.md)。
- 主助手另执行原版负向探针：主动session.closed/runtime_failed后ensureAgentLoaded及commands仍返回原Agent/session，不会清finalized；不能靠自发closed骗出重开（`../logs/host-passive-close-probe.json`）。

所有结果仍为离线原版类+临时状态/命令替身，不是实际数据库、网络或UI验收。
