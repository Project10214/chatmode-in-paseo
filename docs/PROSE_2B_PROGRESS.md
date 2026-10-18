# 2B 原始正文接线：第一批执行记录

状态：**in_progress，部分完成，不能部署/验收**（2026-10-18）。

## 已串起的生产行为

- manifest 安装 MAIN 原文读取器和 ISOLATED adapter；实际 content 观察器异步补读，不等待消息完成，不阻塞按钮、权限、其他来源或 RPC 重试。
- 每条正式来源显式携带 prose 的 pending/available/unavailable 状态。账本保留 DOM 原文、原始表示和非前缀改稿；每来源解析状态持久化，观察时间不制造新修订。
- 转换进入现有投影及 **2A 同一实际 Provider 出口**。没有新 broker.observe、完成后采集或并行旧观察器。
- 无原文时是明确的字面 DOM 回退，不伪称 Markdown。旧的无表示标注持久化项不被追溯重解释；新扩展正式来源全部有显式表示状态。
- Markdown/DIL 增量、UTF-16 尾部、520行公式、重新打开 Store 后的解析状态、待命后补入正文、重复读取已有组合验证。
- 已完成消息的 **公开 own data** completed/terminal status 仅可提供单消息语法 EOF；不调用 getter，不决定运行状态，缺乏证据时不猜 EOF。
- 异步读完时来源已折叠仍保存已采集的公开正文；观察租约/路由失效时旧回调不能写新会话。
- 补充原文使单项超384KiB时显式报告 items.prose 超限；若 DOM 单独能装下则保留并明确回退，不能让它永久 pending。没有截断原文冒充成功。

## 组合测试暴露并修复的交付竞态

本地解析状态不是发布证明。修订当前正文后必须交给交付协调器，不能被旧转换输出遮蔽。

进一步红测证明：durable prepared 已落盘、forward 尚未发生时，新版来源可能已经采集。旧代码仍会发布旧版，随后对新版报分歧。现按来源在实际 emit 前复核新鲜度；**只撤销本进程已知尚未 forward 的 prepared intent**。重启后的 prepared、uncertain、sent 不得走该捷径。已发布非前缀正文仍保留新来源并拒绝错误拼接，不声称可原地替换。

证据：`../logs/prose-prepare-race-red.log`、PD-13、PD-HOST-3。

## 证据层级与限制

- 定向113/113：Source ledger/prose、实际 Broker 投影、监控、实际 Provider（合成投影）、原版宿主进程内门禁。此数字混合层级，**不是113条真实网页验收**。
- `tests/prose-source-flow-browser.py` 六组：真实 Chromium 双世界脚本 → 真实 content/page-view → 实际 Broker/转换器/Provider → pinned 原版 SDK/Session/AgentManager → pinned 原版客户端流式 reducer。
- 六组为 Markdown、DIL、不可读回退、已发布改稿、读后折叠、旧路由撤销。React 模型和页面布局是合成 fixture，Python/stdin 代替扩展 HTTP；没有真实账号、daemon/socket/IPC 或 UI 渲染验收。
- 宿主投影可能分段；上述流式 reducer 在这些案例中按真实 messageId 合成一个 native assistant 项。**不推广为冷 refetch、跨epoch或全部UI场景的单气泡保证**，也不等于 Markdown 实际组件渲染验收。
- 原公开读取器39组再次通过，未触碰私有 getter、点击、Send/Stop/授权。
- typecheck、JS语法及 diff 检查通过。

## 全量与未解决的时序问题

- 最新并发4复跑（连续两次）：**745项 / 745通过 / 0失败 / 0取消 / 0跳过**。
- 本轮起点：840项 / 706通过 / 134失败 / 0取消 / 0跳过（接收器 11 项已迁移）。
- 更早的默认并发曾出现 PD-1 等待超时、2 个文件累计 15 秒预算取消；该配置未复核，不能与受控复跑混报。
- 不同并发配置不能合并成绿灯。定向通过和受控复跑不能抹去间歇问题；未提高超时、未跳过用例。
- Node 离线套件已全绿。红转绿来自逐项迁移/等价替代/退役，不来自提高断言上限或跳过；每次退役都写明对应新用例。
- 递送确认等待预算从 1s 调到 4s：实测同一确认单独约 0.95s、4 路并发约 1.6-1.8s。断言未放宽、未跳过；15s 用例超时仍会捕获真正挂起。

## 47项逐一交代

**47 项已全部交代：迁移到当前契约、按等价契约替代、或退役并映射；不再有“未验收”行。** 下表是逐项记录，不是把相近的新测试自动抵扣旧用例；每行写出对应的新用例或仍缺的证据。入口迁移阻塞不代表后续业务正确，也不是已定位的生产根因。


| 原编号 | 原用例 | 结果 | 契约或仍需解决的边界 |
|---|---|---|---|
| F-001 | `append-only-production.test.mjs`<br>PROD same-ID updates keep one canonical final: equal re-reads are unchanged, late unfinished reads send nothing | 已迁移：PROD 同 ID | 等量重读幂等；更短的迟到读取不替换、不截断已交付正文。 |
| F-002 | `append-only-production.test.mjs`<br>PROD source object answer identities must never be deduped by equal prose | 已迁移：PROD 身份 | 相同正文、不同原生 ID 不会被去重成一条。 |
| F-003 | `append-only-production.test.mjs`<br>PROD source reference unavailable is never a placeholder or an empty successful body | 已迁移：PROD 空正文 | 空来源不成为空成功正文；不可读原文用字面回退。 |
| F-004 | `append-only-production.test.mjs`<br>PROD raw revision is isolated to its message, retained as an issue, never fake final | 等价契约替代已通过 | CM-R4/PD-11：已发布正文的非前缀改稿保留但不替换，也不成为完成。 |
| F-005 | `append-only-production.test.mjs`<br>PROD stale shorter native read during or after generation does not override the canonical body | 已迁移：PROD 迟到读取 | 见 F-001 同一用例：较短/迟到读取只入账，不覆盖已交付正文。 |
| F-006 | `append-only-production.test.mjs`<br>PROD end-to-end sourceFor -> real Broker message entry -> real Provider -> host -> replay | 等价契约替代已通过 | CPROV-08 重连重放只交付一次正文；CPROV-01/CONTOBS-05 过程行独立；CM-P1 精确投影。 |
| F-007 | `append-only-production.test.mjs`<br>PROD real content observe -> Broker retains page facts and observation after a prose failure | 等价契约替代已通过 | CONTOBS-04/CONTOBS-10/CPROV-07：读取失败是问题项，不是状态或完成。 |
| F-021 | `completed-message-http.test.mjs`<br>CM-HTTP1 receipts over /event: stored, unchanged after restart, rejected, malformed and unauthenticated | 已迁移：page-view HTTP | /page-view 的入库、重复、序列冲突、畸形、未认证与重启（真实 runtime/端口/配对）；旧 /event 回执通道已移除。 |
| F-022 | `completed-message-observer.test.mjs`<br>CM observer: approval waiting does not hide an already completed message or grant permission | 已迁移：Observer | 同一帧内开放授权与已完成正文并存；观察不自动应答授权。 |
| F-023 | `completed-message-observer.test.mjs`<br>CM observer: pending prose is not sent; page/activity remain live, completed commentary need not wait for turn end | 已迁移：Observer | 原文补读只挂起该条正文，页面状态/其他来源仍上报；PROSE-FLOW-3 同证。 |
| F-024 | `completed-message-observer.test.mjs`<br>CM observer: completed final-channel body is delivered before the task ends, then task completion reuses its receipt | 已迁移：Observer | 运行中先交付正文，待命复用同一正文，不重发。 |
| F-025 | `completed-message-observer.test.mjs`<br>CM observer: raw DIL goes to receiver unmodified and final uses its revision receipt | 已迁移：Observer | DIL 原文原样入账，只在投影时解码。 |
| F-026 | `completed-message-observer.test.mjs`<br>CM observer: receiver rejection is not a delivery confirmation or successful turn | 已迁移：Observer | 被拒绝修订不是交付确认，也不是本轮完成。 |
| F-027 | `completed-message-observer.test.mjs`<br>CM observer: stored A after rejected B is re-confirmed under the same identity, not merely cleared from a cache | 已迁移：Observer | A→B(拒)→A 以同一来源身份重新确认，无重复正文。 |
| F-028 | `completed-message-observer.test.mjs`<br>CM observer: lost receipt retries same message identity, never native Send | 等价契约替代已通过 | MON-05 原帧/原序号重试；观察链路不产生 Send。 |
| F-029 | `completed-message-observer.test.mjs`<br>CM observer: pending earlier prose does not let a later tool row overtake native order | 已迁移：Observer | 同帧 order 决定顺序；原文待补时后续行先发布为已记录边界，不设正文门禁。 |
| F-030 | `completed-message-observer.test.mjs`<br>CM observer: confirmed native Stop flushes visible interrupted text instead of dropping it | 等价契约替代已通过 | CM-R8/CM-P2 确认 Stop 后补入可见半段，不重开轮次。 |
| F-031 | `completed-message-receiver.test.mjs`<br>CM-R1 a complete message is stored once, durably, with a truthful receipt and turn metadata | 已迁移：CM-R1 | 部分原文只落账一次；本地接受不等于宿主交付或完成。 |
| F-032 | `completed-message-receiver.test.mjs`<br>CM-R2 the same native message and revision is idempotent, also after a restart and observer rebind | 已迁移：CM-R2 | 重启/重绑后同来源身份幂等，不重放 Send。 |
| F-033 | `completed-message-receiver.test.mjs`<br>CM-R3 DIL is decoded once on the receiver; the revision covers the raw public string | 已迁移：CM-R3 | DIL 仅解码一次，修订覆盖原始公开字符串。 |
| F-034 | `completed-message-receiver.test.mjs`<br>CM-R4 a real revision of a delivered message is rejected, kept as an issue, and never final success | 已迁移：CM-R4 | 已发布正文的真实改稿被拒并保留问题，不是成功终点。 |
| F-035 | `completed-message-receiver.test.mjs`<br>CM-R5 legacy streamed history: equal is unchanged, a prefix is completed in place, a conflict is rejected | 已迁移：CM-R5 | 历史原生身份在接管、前缀增长与冲突修订下保持。 |
| F-036 | `completed-message-receiver.test.mjs`<br>CM-R6 bounded, strict validation; identity mismatches never become receipts | 等价契约替代已通过 | 保留类型、Unicode/NUL、有限数值顺序、观察归属、真实原生身份、空正文和补读身份校验；Markdown、partial、旧256k/位置深度限制由新契约替代。 |
| F-037 | `completed-message-receiver.test.mjs`<br>CM-R7 completion still needs the native terminal and the matching delivered final revision | 已迁移：CM-R7 | final/EOF 元数据与本地回执都不能选择状态或证明宿主交付。 |
| F-038 | `completed-message-receiver.test.mjs`<br>CM-R8 after a CONFIRMED Stop, the last visible part is recorded as interrupted without reopening the turn | 已迁移：CM-R8 | 确认 Stop 后补记可见半段，不重开轮次。 |
| F-039 | `completed-message-receiver.test.mjs`<br>CM-R9 no late body for unproven stops, CIP errors, settled turns or superseded turns | 已迁移：CM-R9 | 未证实 Stop、观察缺口与新提示都不构成正文丢失门禁。 |
| F-040 | `completed-message-receiver.test.mjs`<br>CM-R10 per-turn message capacity is reported, not thrown and not terminal | 等价契约替代已通过 | 不恢复16条限额；40+迟到第41条不截断，线缆按384KiB UTF-8预算拆分/显式拒绝。 |
| F-041 | `completed-message-receiver.test.mjs`<br>CM-P1 Provider emits one exact native assistant item per stored message; host stays unconfirmed | 已迁移：CM-P1 | 实际 Provider 每条来源只发原生正文；宿主未确认前不算交付。 |
| F-042 | `completed-message-receiver.test.mjs`<br>CM-P2 Provider forwards an interrupted body for a stopped turn without a new turn lifecycle | 已迁移：CM-P2 | 停止尾部正文可继续交付，不新增轮次生命周期。 |
| F-043 | `completed-message-receiver.test.mjs`<br>CM-R11 the legacy snapshot lane cannot alter a body delivered by the message lane | 已迁移：CM-R11 | 旧快照通道已不存在；后到原文不覆盖已交付正文。 |
| F-044 | `content-observation.test.mjs`<br>observer sends every completed prose item and tool in source order, stops before a pending message, never only the last answer | 已迁移：Observer 源序 | 每 tick 上报全部可见来源，顺序按 order，不只最后一条回答。 |
| F-045 | `content-observation.test.mjs`<br>a pending earlier message holds later tool rows, but the activity card stays live | 已迁移：Observer 待读 | 原文待读只挂起该条正文，后续行与状态卡继续上报（旧“阻塞后续行”已被授权取消）。 |
| F-046 | `content-observation.test.mjs`<br>page facts keep flowing when prose/anchor is unavailable; no native Stop or Send | 已迁移：Observer 读失败 | 内容失败与按钮读取独立；同一观察在下一 tick 恢复，不产生 Stop/Send/授权。 |
| F-047 | `content-observation.test.mjs`<br>an unreadable completed message is a visible issue, never an empty successful body or completion | 已迁移：Observer 不可读项 | 不可读条目成为可见 issue，不伪造空正文或完成。 |
| F-048 | `content-observation.test.mjs`<br>only a stored/unchanged receipt with the same revision counts; a rejected revision blocks completion | 等价契约替代已通过 | CM-R1/CM-R4：只有本地产接受不是交付；被拒修订不成为完成。Observer 侧由“仅待命结束本轮”用例复核。 |
| F-049 | `content-observation.test.mjs`<br>a recovery descriptor resumes observation only after exact anchor proof, without replaying a command | 已迁移：Observer 重绑 | 旧文档/路由失效后必须换新 lease 才恢复；新 epoch 序列从头计，不重放命令。 |
| F-091 | `message-receipt-integrity.test.mjs`<br>message receipt: an old interrupted revision cannot certify a later completed final | 等价替代已通过 | CM-R7：final/EOF 元数据与本地回执不能选择状态；CM-R4 拒绝已发布正文的非前缀改稿。 |
| F-092 | `message-receipt-integrity.test.mjs`<br>message receipt: equivalent COMPLETE representations can be recognized without a second body | 等价替代已通过 | CM-R2/CM-R3：同来源等量重读幂等，DIL 只解码一次，不产生第二份正文。 |
| F-093 | `message-reconciliation.test.mjs`<br>reconcile: re-reading the stored complete version resolves its rejection without a second body | 等价替代已通过 | observer “A→B(拒)→A 同身份重新确认（无第二份正文）”用例。 |
| F-094 | `message-reconciliation.test.mjs`<br>reconcile: citing an old receipt alone cannot clear a rejected source revision | 等价替代已通过 | CM-R4/PD-11：旧回执不能清除已发布正文的修订拒绝事实。 |
| F-095 | `message-reconciliation.test.mjs`<br>reconcile: positive proof for one message cannot clear another or an unknown/status failure | 等价替代已通过 | CM-R6：问题按来源归属，一个来源的证据不能清除另一个来源的问题。 |
| F-125 | `public-prose-incident.test.mjs`<br>incident: unfinished representation changes are not locked in; a delivered body revision is refused at the Broker | 退役并映射 | 事故语料已由 PROSE-FLOW-1/2（未完成表示不锁定）与 CM-R4（已发布改稿被拒）覆盖。 |
| F-126 | `public-prose-incident.test.mjs`<br>incident: observation failure is not proof that the native task has stopped | 退役并映射 | CONTOBS-10 + CM-R9：观察失败不是原生任务已停止，也不是本轮完成。 |
| F-127 | `public-prose-regressions.test.mjs`<br>prose: a delivered body that later changes stays refused at the receiver, also for a later extension | 退役并映射 | CM-R4 + CM-R11：已发布正文的后续变化仍被交付层拒绝，新原文只留在账本。 |
| F-143 | `sync-lanes.test.mjs`<br>SYNC page-carried prose issues affect health, and another message cannot clear their ownership | 退役并映射 | 旧 health/turn.sync 通道移除；问题显示在 page-state 卡（CONTOBS-04/10、CPROV-10）。 |
| F-144 | `sync-lanes.test.mjs`<br>SYNC status delivery failure is not repaired by prose; fresh status delivery repairs its own lane | 退役并映射 | 状态投递不再有独立通道；正文不再修补状态。交付待确认由 native-content-delivery 通知表达（PD-2）。 |
| F-145 | `sync-lanes.test.mjs`<br>SYNC terminal tracking does not invent a native tool cancellation or erase its visible detail | 退役并映射 | TIMELINE-04 + CM-R8：待命/停止不伪造工具终态，也不擦除可见详情。 |

机器记录：`../logs/prose-2b-accounting-47.json`；完整运行配置与失败索引：`../logs/prose-wiring-failure-index.json`。原147项分类文档保留为历史基线。
## 迁移批次记录

| 批次 | 覆盖 | 结果与证据 |
|---|---|---|
| 接收器（前一批） | F-031…F-035、F-037…F-039、F-041…F-043，共 11 项 | 重写为来源账本→实际 Provider→合成宿主投影；定向通过；全量复核见 `../logs/continue-full-1954.log`。 |
| Observer | F-022…F-030，共 9 项 | 7 项重写为 page-view/Broker/实际 Provider 链；F-028 由 MON-05、F-030 由 CM-R8/CM-P2 等价替代；定向 7/7，见 `../logs/observer-batch-full.log`。 |
| PROD 生产入口（本批） | F-001…F-007，共 7 项 | 3 项重写（同 ID 规范正文/身份不去重/空与不可读来源）；4 项按 CM-R4、PD-11、CPROV-08、CONTOBS 系列等价替代；定向 9/9。 |
| content-observation（本批） | F-044…F-049，共 6 项 | 6 项重写到 content.js 当前 page-view 契约（源序、待读只挂自身、读失败隔离、不可读项、仅待命收尾、重绑新 lease）；定向 6/6。共享 harness 抽到 `tests/fixtures/content-page.mjs`，MON 27/27 保持通过。 |
| 文案 | COPY 2 项 | 图片卡改为“压缩预览 · 非原文件 / 打开原对话”，不再声称原图下载；Provider 通知改为“异常／状态无法确认”“正文修订无法原位同步”“授权框已关闭”，不推断运行/完成/批准。定向 13/13。 |
| 宿主屏障（本批） | HB 11 项 | HB-1/HB-3 与 HB-2/HB-5 合并为 2 个当前链用例（屏障未证实时不发生命周期、源仍入账；关闭的绑定不能被后来屏障复活；新会话自己的屏障）。HB-4/4b 归入已记录的 OBS-P1 宿主限制与 CONTOBS-01/CM-R2；HB-8 由本批未被 woken 的用例覆盖；HB-9/10/11/12/13 属已移除的快照积压机制，映射到 native-delivery/CM-R10/CM-R8/CONTOBS-10。定向 2/2。 |
| 生命周期（本批） | 11 项 | T01/T08/T13 更新为“待确认回执=活动观察运行（running）”；T13 的迟到回执改走原命令结果；T11 用待命结束释放槽位；T12 用当前 Provider 重连 + 来源帧；T15 用当前 rebind（旧 stopping 状态已不存在）。T02/03/04/09/10 的心跳/receipt_recovered/observation_gap/watchdog 机制已移除，逐条映射到 T01/T06/T13、CONTOBS、CM-R9。定向 10/10。 |
| 图片（本批） | 10 项 | 旧 images.test.mjs 的图片通道已由 artifacts(16)+artifact-transfer(25) 全面替代：原字节/分块/摘要、MIME/尺寸/上限、篡改与符号链接、会话授权读取、幂等 ACK、同资产不降级、占位升级同 ID、无 turn 门控。逐条映射后文件退役。 |
| 时间线/小套件（本批） | 7 项 | TIMELINE-04 改为来源 upsert（tool/reasoning 同 ID 原位更新、待命不伪造工具终态）；TIMELINE-05 改为实际 Provider 发射 + 重连各重放一次；TIMELINE-SDK 退役（所有世界事件已由 ProviderEventSchema 校验）；I02 在发送被观察/结算后才期待一次 prompt_result；sync-lanes 的 health/status/terminal 通道已移除，映射到 page-state issues、PD-2 通知与 TIMELINE-04/CM-R8。 |
| HTTP（本批） | 2 项 | 新增真实 runtime HTTP harness（临时目录/端口 0/配对/重启）：/page-view 的入库、重复、序列冲突、畸形、未认证与重启；/observations 列表、rebind 租约轮换与身份拒绝、旧租约写入拒绝、新租约接收、observation gap 记录。旧 /event、/active、/recover-observation 已不存在。 |
| 修订/导入（本批） | 22 项 | revision：R01 双重 Stop 共用一个命令、结果结算两个等待者；R02 旧轮失败不影响新轮；R09 文档重载只重绑；R11 失联只影响本会话；R15 上下文仍作为用户级文本；R19 开放授权与外部关闭通知区分（并修复非 permission 客户端关闭后通知不消失）。R05/R06/R08 的每轮片段上限已不存在，映射到帧上限/CM-R10。bidirectional-turns：TURN-C/D/G 保留并改用待命收尾；A/B/F 的 importExternalTurn 通道已移除并映射；TURN-HTTP 重写为“每个新帧只唤醒一次、重复帧不唤醒、不产生 Send”；bidirectional-turns-browser 3 项的 external-candidate IPC 已移除（MON-23），身份/路由拒绝由 MON-11/12 与账本身份冲突覆盖，文件退役。 |
| 恢复（本批） | 12 项 | observation-recovery 的 /active + /recover-observation 失败轮恢复通道已移除；新增事故恢复用例：不可读页面不失败本轮、账本历史保留、换文档靠重绑新租约继续、不新增 Send/Stop。其余逐条映射（CONTOBS-10、CM-R4、CM-R9、MON-09/10、OBS-HTTP1、TIMELINE-04）。OBS-P1/P2/P3/H1 的宿主限制保留在 docs/IN_PLACE_RECOVERY_PLAN.md 与 OBS_P1_VERIFICATION.md，未声称已解决。 |
| 绑定/监视 | 12 项 | LINK4/5/6/10/11 属已移除的 binding_lost/heartbeat/浏览器 Stop 机制，逐条映射到 CONTOBS/CM/MON；LINK7 重写为当前 ensure 用例（不确定的第二次 Send 后不得要求旧原生用户 ID）。monitor-gap 保留 1 个“无原生用户锚仍持续上报”用例；monitor-ping 重写为“安静页面不按时间完成”；LATE-9/10 属已移除的 external-candidate 与异步身份等待。定向 6/6 + 1/1 + 1/1 + 8/8。 |
| 活动/状态卡（本批） | 15 项 | native-activity：保留 NATIVE1 校验器，新增“一个公开工具源=一个原位更新的 tool_call 卡、不伪造正文”。page-observation：保留 PAGE-A1 校验器，新增“只看按钮的一页状态卡原位更新、不是终点、Provider 同 ID upsert”。strict-regression：旧 activity 卡/watchdog 断言退役，新增“重启保留页状态卡且不伪造完成、不重放 Send/Stop”。定向 2/2 + 2/2 + 1/1。 |
| 旧回执退役 | 8 项 | message-receipt-integrity(2) 与 message-reconciliation(3) 只验证已移除的逐消息回执/最终确认/turn.sync 机制，文件退役；public-prose-incident(2)、public-prose-regressions(1) 中同类的失败用例退役。映射逐条写在文件内注释：CM-R7/R8、CM-R2/R3、CM-R4/R11、CM-R6、PROSE-FLOW-1/2、CONTOBS-10、observer A→B→A 用例。 |

## 浏览器与宿主门禁（2026-10-18）

- 当前契约的隔离 Chromium：page-content(71 检查)、continuous-actions(40)、button-state(18 组合)、artifact(13 组)、public-message(39)、prose-source-flow(6 组)、media-source-flow(3 组) 全部通过。
- 旧契约浏览器脚本：page-observation、approval-card、completed-message、public-prose-incident、append-only-public 依赖已移除的 CIP_DOM 方法/接口，逐条映射到上面通过的新套件与 Node 的 CM/PROSE-FLOW/OBS 用例后退役（映射见 docs/TESTING.md 与批次记录）。
- 旧浏览器/宿主诊断套件已归档到 `tests/legacy/`（逐文件映射见 `tests/legacy/README.md`），不再进入绿灯统计。当前可重复门禁：Node 745/745、SDK 2/2、原版宿主 4/4、隔离 Chromium/MV3 **26/26**。
- 真实 MV3 端到端已重建并通过（`tests/binding-mv3-current.py`，6 项，连续两次）：真实 unpacked 扩展/worker/worlds/Chrome tabs/Node Runtime；一个 Send 只产生一条用户回声和一条助手正文，重载不重发，第二轮只多一个 Send，ChatGPT 手动输入被当作网页来源。页面/网络仍是离线夹具。
- 部署前仍缺：真实 ChatGPT 页面标记复跑、真实账号/UI、AgentManager 自身 pendingRun 暂存路径。
- `npm run verify:upstream` PASS（13 个来源模块与哈希、MIT 声明、manifest worlds）。
- 原版宿主门禁已迁移：新 `tests/host-observation-current.mjs`（`npm run test:host-gate`）在固定 **@getpaseo/server@0.12.0-beta.2** 的原版 AgentManager/PluginAgentClient/ensureAgentLoaded/listCommands 与真实 CIP Provider/Broker 上 **4/4 通过**：
  - 屏障未确认时，正文只入账、不交付；确认后只交付一次，宿主拿到原 Paseo turnId；待命结束一次。
  - 替换宿主连接后，旧 Barrier 结果不能解锁新绑定；新连接用自己的 commands() 屏障交付一次。
  - 宿主侧 cancel：经真实 AgentManager → session.interrupt → 网页 Stop 命令；点击回执后不结束本轮，随后可见的半段尾部仍交付一次，最后待命帧结束本轮（一次）。
  - 第二个提示：通过真实宿主 PluginAgentSession.startTurn 在首轮运行中发出；首轮不产生第二个 Send，等待期间到达的尾部帧被 Provider 暂存，待命后重放一次，既有正文不重复、不丢失。注意：这里驱动的是会话层 prompt，不是 AgentManager 自己的排队暂存路径。
- 旧 `host-observation-real.mjs` 的 REAL-1…REAL-12 是已移除的“失败轮原位恢复”通道（`recoverObservation`、failed turn 重建、/recover-observation）。该文件退役；其中仍有效的屏障/交付/替换连接断言已进入新门禁，Stop-tail 与 pending-prompt 都已在新的宿主门禁覆盖（HOST-CURRENT-3/4）。pending-prompt 覆盖的是真实宿主会话（startTurn）层；AgentManager 自身的 pendingRun 暂存路径未被单独驱动，不能扩大为“宿主排队全路径”验收。
- 宿主能力诊断已归档；其中 RED 记录的真实限制（跨片段工具卡、最终文本契约）保留在文档中，不是验收。

## 测试面收尾（2026-10-18）

- `tests/sdk-contract.mjs` 迁移到当前发送/Stop 流程，2/2 通过。
- 旧浏览器/MV3 脚本与两份宿主诊断移入 `tests/legacy/`；npm 中对应的 `test:*` 改为 `legacy:*` 或移除，避免把旧套件当门禁。
- 隔离 Chromium/MV3 当前 26/26；新增的 `binding-mv3-current.py` 是当前契约的真实 MV3 端到端（离线夹具），旧 MV3 脚本不再是缺口。

## 结论与仍需真实验收的部分

Node 离线链已全绿（745/745，连续两次），但这不等于实机验收：

- 已运行当前契约的隔离 Chromium 套件、`verify:upstream` 与新的原版宿主门禁（固定 beta.2，2/2）；未接触真实 daemon/IPC/账号/UI。
- 宿主限制仍未解决、也未声称解决：OBS-P1 的 finalized foreground turn 原位恢复（docs/IN_PLACE_RECOVERY_PLAN.md、OBS_P1_VERIFICATION.md）、跨运行片段工具卡合并、原生下载 API 缺失（ART13）。
- 大量修改仍未提交；线上安装目录未更新，未部署。

下一步若继续：在固定 Paseo 版本上跑 Python Chromium 与宿主门禁、做实机收发验收、再决定提交/部署；不要用离线绿灯代替实机结论。

本批全量：**745项 / 745通过 / 0失败 / 0取消 / 0跳过**，连续两次一致，见 `../logs/final-full.log`、`../logs/final-full-2.log`。


机器记录：`../logs/prose-2b-accounting-47.json`；完整运行配置与失败索引：`../logs/prose-wiring-failure-index.json`。原147项分类文档保留为历史基线。
