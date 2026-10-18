# 订阅与并发交付不是同一个屏障

2026-10-17；未发布alpha.4.20；原版 `@getpaseo/server@0.11.4`及`0.12.0-beta.1`。

## 当前产品契约（用户 2026-10-17 确认）

- **显示按到达顺序**：迟到的旧正文可以出现在新提示之后，也可能被 Paseo 记到新轮次名下（`turnId`）。这是**已知限制**，不再作为门禁；影响仅限“按轮次取最后回复”的自动化调用方和轮次状态展示。
- **必须保证**：旧正文不丢、不重复。
- **插件侧修复**：Provider 在某个 binding 准备新提示期间，把到达的 `timeline.item` 与 `session.turn` 按序暂存在插件内（同 ID 完整快照原位替换）。新提示被接受时立即交付；失败时在发出失败结果后的下一个宏任务交付，此时宿主已结清失败的 pending run，不会再把它们 staged 后丢弃。
- **验证**：REAL-9 两个窗口改为“旧/新正文各可见一次”，REAL-12 改为“失败后旧正文可见一次且 Agent 仍可用”；两版原版宿主类均 13/13 通过。去掉修复后 REAL-12 与新增单测 `provider.test.mjs` 均失败。
- **残余窗口**：宿主已建立 pending、但新提示尚未到达插件进程的 IPC 在途期间（毫秒级），插件已发出的条目若在新提示失败时被宿主丢弃，插件无法感知。插件拿不到宿主是否已保存的证据，盲目补发会导致正文重复（宿主按相同 `messageId` 相邻合并），所以不补发。

以下为契约调整前的分析，保留作根因记录。

## 可复现的实际后果

CIP 已保存旧轮完整正文，正在等待新宿主 binding 的独立订阅证明。宿主已经订阅但 commands 回复尚未返回时，用户提交新提示：

1. 若新提示成功，旧正文排在新 user 后面；其 SDK `messageId` 仍为 `assistant:<旧turn>:final`，宿主行的 `turnId` 却是新 turn。
2. 若新提示在 Send 之前失败，旧正文仍在 CIP 的 Store，但被宿主暂存后丢弃，实际时间线中没有该正文。
3. 屏障在 Provider 收到新提示之前或之后释放，都可触发问题。单纯在 `session.prompt` 中检查不覆盖前一个窗口。

测试：`tests/host-observation-real.mjs` 的 REAL-9 before-provider、after-provider 和 REAL-12。使用原版完整 AgentManager/AgentRunState/PluginAgentClient/ProviderRuntime，真实 CIP Broker/Provider，只有浏览器命令、存储和 list_commands RPC 外壳为临时夹具。没有真实daemon/WebSocket/数据库/账号操作。

```sh
CIP_PASEO_SERVER_PACKAGE=/path/to/extracted/@getpaseo/server-0.11.4/package \
  npm run test:host-recovery
```

包版本、源码哈希与依赖必须匹配；不匹配明确报错，不skip。来源见 [恢复执行审计](HOST_RECOVERY_EXECUTION_AUDIT.md)。最新双版本日志 `../logs/paseo-012-real-{0.11.4,0.12.0-beta.1}.log`：两版均13项10过3红0skip。升级beta.1没有修复这些门禁；兼容准入另见 [PASEO_012_COMPATIBILITY.md](PASEO_012_COMPATIBILITY.md)。

## 原版代码链

以下行号为固定0.11.4 npm包的 `dist/server/server/agent/`：

| 文件/位置 | 实际行为 |
|---|---|
| agent-manager.js:1653,1595 | 先 createPendingRun，再等待 Provider startTurn；Provider收到请求时宿主已pending |
| agent-manager.js:2640–2643 | pending期间所有session事件进入stagedEvents，不按旧/新turn区别处理 |
| agent-manager.js:1683–1696 | 新提示接受后先写新user，再回放stagedEvents |
| agent-manager.js:1596–1623 | 启动失败结清并清理pending run，不回放其stagedEvents |
| plugin-provider.js:1126–1137 | timeline翻译使用currentTurnId，不从原生消息ID恢复旧轮归属 |
| agent-manager.js:132–155,2956 | 无turnId的live条目补上当前前台turnId |
| SDK ProviderEventSchema timeline.item | 没有显式turnId字段；追加未知字段会被strip |

真实类结果同时排除了“只要SDK消息ID不变，宿主就会自动正确归轮”的假设。消息身份、宿主运行身份、显示源序不是可互相替代的证据。

## 已有修复仍有效，但不能覆盖此门禁

- 新binding自己的commands成功，可证明已订阅；失败、旧binding回执不能释放。
- 同ID完整快照合并、有序暂存避免订阅前历史priming吞正文/终态。
- 原生任务已结束时不补发started。
- 未交付的过期跟踪failed在强证明恢复后被替换；确证Stop后的半段正文位于尚未交付的canceled之前。
- 同一旧连接已finalized的前台轮次恢复在改变CIP状态前安全拒绝；OBS-P1仍不是功能成功。

**commands不提供“宿主没有pending且交付期间也不会进入pending”的原子保证。**

## 不采用的绕过

- 不补flush后宣称安全；flush本身仍会进入宿主stagedEvents。
- 不以延时、下一次commands或一次状态快照推断安全窗口。
- 不伪造started设置currentTurnId，不新造观察turnId，不追加第二份正文。
- 不把Provider发出/清空held当成宿主已保存，更不承诺重开必然补回所有提示和终态。
- 不自动重建原Agent连接、刷新网页、重发任务或修改安装宿主。

在可检测碰撞时“拒绝新提示、冻结旧held”最多是局部止损：改变已有新消息等待/排队语义，仍不能覆盖pending早于Provider输入的窗口。本轮未擅自实施这种契约变更。

## 闭环需要的能力与决策

需在宿主侧提供并实测下列能力之一（接口设计尚未实施）：

1. **pending建立前的原子协调边界**：排空并处理旧轮待交付事件，且不会在交付中插入新前台pending。还须定义迟到旧内容的处理，不能只加一次非原子查询。
2. **带明确归属及源序的历史交付/更新接口**：旧条目不被新pending接管或丢弃，并能放回正确位置。只有显式turnId还不足以修顺序；同ID正文修订和机器最终结果也需各自能力验证。

仅修改CIP无法给现有公开接口补上这些保证。若要推进宿主侧离线实现，需另行确认范围/仓库；这不等于获准安装、重启daemon、操作真实Agent或更换原生身份。在原约束不变时，保留这些红门禁，不能把已知缺口包装成完整交付。
