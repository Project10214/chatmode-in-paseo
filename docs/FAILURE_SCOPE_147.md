# 147项失败：链路与局部范围分类

> 以下保留分类时的历史基线。2B执行后的逐项进展见 [PROSE_2B_PROGRESS.md](PROSE_2B_PROGRESS.md)：2项局部等价替代通过，45项正文链路仍未验收。

状态：todo，2026-10-18；本轮只读核查与分类，未修改生产代码或原测试、未重新执行测试。

## 口径与结论

基于最新失败索引 `../logs/provider-wiring-failure-index.json`，以及31个测试文件中每条失败用例的断言/驱动。

- **链路类：123项。** 验收依赖生产模块、协议或不同生命周期职责的协作。例如采集→传输→接收/落盘→投影→宿主，以及Send/Stop→回执→观察→运行结束。用stub模拟对端，不会自动把这些业务要求变成局部问题。
- **局部规则类：24项。** 目标可在一个明确责任边界验证，例如输入/归属拒绝、导航epoch守卫、资源完整性、文案。为准备数据而启动Broker/Store，不自动等于该断言必须全链验收。
- 同时验证局部规则和多阶段过程的混合用例，保守放在链路类。局部用例修完后仍须跑相关链路和全量。
- **这是第一轮“修复/验收范围”分类，不是已确认的根因或修复工时。** 某一处局部缺陷可能引发很多链路失败；局部类也可能在迁移入口后暴露更深问题，届时升为链路类并更新记录。
- 不按“broker.observe不存在”判断局部；这是第一失败点，不能证明后续业务正确。
- 仍然全部标记未解决。不能把旧规则冲突直接算通过，也不能恢复旧接口、完成后才采集、旧限额或recoveryOnly双轨来消红。

基线：并发4、每文件15秒预算的全量831项，684通过/147失败/0取消/0跳过。
默认并发另有Broker文件累计预算超时，**不在147个断言失败内**，单独保留，不能隐去。

## 按业务模块交叉统计

| 业务模块 | 链路类 | 局部类 | 合计 |
|---|---:|---:|---:|
| 正文采集、格式与修订 | 45 | 2 | 47 |
| 绑定、发送与生命周期 | 33 | 13 | 46 |
| 宿主交付与恢复 | 22 | 2 | 24 |
| 过程、工具与状态展示 | 17 | 1 | 18 |
| 图片与界面文案 | 6 | 6 | 12 |
| **合计** | **123** | **24** | **147** |

特别说明：正文47项中45项仍属于链路，不是接上格式转换器就自动全绿。宿主24项中22项属于链路，也不能用2A新增组合测试通过来替代旧用例逐项验收。

## 24项局部规则清单

局部规则细分：身份/所有权9，浏览器守卫6，输入/资源验证4，容量策略1，清单策略1，展示映射3。

| 编号 | 局部责任 | 用例 | 边界/注意事项 |
|---|---|---|---|
| F-008 | 身份与所有权 | `tests/bidirectional-turns-adversarial.test.mjs:21`<br>ADV1-01: a duplicate native user id may never silently change body or document | 同一用户源ID的内容/文档冲突与幂等规则，可在来源身份核验边界独立验证。<br>需迁移驱动并保留正、负向断言；尚未确认实现已正确。 |
| F-009 | 身份与所有权 | `tests/bidirectional-turns-adversarial.test.mjs:31`<br>ADV1-02: a second tab must not steal an extant conversation binding | 错误tab/document不得夺取绑定；拒绝前不需要执行下游协议。<br>需迁移驱动并保留正、负向断言；尚未确认实现已正确。 |
| F-010 | 身份与所有权 | `tests/bidirectional-turns-adversarial.test.mjs:38`<br>ADV1-03: durable native id is mandatory for external-gap notices | 缺口报告的输入归属校验，不得把别的tab报告写进当前会话。<br>需迁移驱动并保留正、负向断言；尚未确认实现已正确。 |
| F-011 | 浏览器局部守卫 | `tests/bidirectional-turns-browser.test.mjs:34`<br>TURN-W1: idle ChatGPT page identifies only a NEW anchored user, without sending a message | 内容端用户源识别/不可证明身份拒绝，以及不调用Send的局部读操作规则。<br>旧external-candidate/最新用户anchor门禁需改成统一来源读取契约，不能恢复idle专用采集。 |
| F-013 | 浏览器局部守卫 | `tests/bidirectional-turns-browser.test.mjs:109`<br>TURN-W3: worker declines conflicting routes and unverified candidates | background在错误路由/未验证输入时拒绝转发；可用有效正向fixture对照验证。<br>watchIdle已移除；不能因UNKNOWN_MESSAGE而让负向测试假绿。 |
| F-036 | 输入与资源校验 | `tests/completed-message-receiver.test.mjs:111`<br>CM-R6 bounded, strict validation; identity mismatches never become receipts | 消息字段类型、Unicode/NUL、位置及身份等接收端校验。<br>旧markdown/partial/固定大小等拒绝规则不全适用于新协议，须逐条保留或明确替代，不可照搬全部assert.rejects。 |
| F-040 | 局部容量策略 | `tests/completed-message-receiver.test.mjs:204`<br>CM-R10 per-turn message capacity is reported, not thrown and not terminal | 接收端容量边界与显式拒绝/报告策略，未调用真实Provider或宿主。<br>固定16条/每turn门禁与连续无静默截断要求冲突；应验证新的容量策略，不能为绿测试恢复旧上限。 |
| F-052 | 身份与所有权 | `tests/conversation-binding.test.mjs:73`<br>LINK6 a foreign tab cannot renew a turn by pretending to be alive | 伪造tab/document/lease/URL的输入不能续期或改变当前状态。<br>需迁移驱动并保留正、负向断言；尚未确认实现已正确。 |
| F-072 | 输入与资源校验 | `tests/images.test.mjs:15`<br>IMG6 images require exact native owner, public asset identity and native completion | 媒体owner/asset/native-ID有效性校验。<br>完成标志不再作为采集门禁；保留真实归属/资源身份约束。 |
| F-073 | 输入与资源校验 | `tests/images.test.mjs:16`<br>IMG7 MIME confusion, malformed bytes, excessive dimensions and oversized payload rejected | MIME、字节格式、尺寸、大小等资源验证规则。<br>迁移至实际资源协议；保留恶意/损坏输入拒绝，不能拿旧WebP预览大小限制冒充原文件限制。 |
| F-074 | 身份与所有权 | `tests/images.test.mjs:17`<br>IMG8 RPC cannot read media without the matching session and turn history | 媒体读取授权必须匹配会话、资源标识及已存储历史。<br>旧turnId读取契约需迁移为session/source/digest授权，不减少跨会话和路径攻击覆盖。 |
| F-075 | 输入与资源校验 | `tests/images.test.mjs:18`<br>IMG9 byte corruption and symlink replacement are refused | 存储层完整性与符号链接替换拒绝，可在文件读取边界独立验证。<br>需迁移驱动并保留正、负向断言；尚未确认实现已正确。 |
| F-078 | 浏览器局部守卫 | `tests/late-browser-receipt.test.mjs:138`<br>LATE-9 same-page event during external-user read does not abort import discovery | 同页事件与真正路由变更的区分，局部异步读取不得被误撤销。<br>外部用户发现旧入口已移除，迁到现行读取路径，保留无导航不误撤销。 |
| F-079 | 浏览器局部守卫 | `tests/late-browser-receipt.test.mjs:146`<br>LATE-10 actual A-B-A route departure still rejects pending identity | A→B→A的epoch撤销规则，旧身份不可复活。<br>identity已同步化，不能要求已返回的旧RPC事后改变；应验证旧lease/epoch不可用于后续观察。 |
| F-083 | 身份与所有权 | `tests/lifecycle-timeouts.test.mjs:60`<br>LIVE-T04: wrong lease, tab, route or layout identity cannot recover pending delivery | recoverReceipt输入的Send lease、tab、route、document、原生ID校验。<br>需迁移驱动并保留正、负向断言；尚未确认实现已正确。 |
| F-097 | 浏览器局部守卫 | `tests/monitor-gap.test.mjs:69`<br>NATIVE-GAP2 A→B→A browser navigation invalidates a previously established monitor | 当前内容观察器的路由epoch失效与旧monitor拒绝。<br>不保留旧/event failed终止语义；保留撤销/重绑安全要求。 |
| F-098 | 浏览器局部守卫 | `tests/monitor-gap.test.mjs:81`<br>NATIVE-GAP3 monitor heartbeat requires native in-progress evidence, not simply a live tab | 局部监控/状态证据规则，不能用活tab或native in_progress元数据推断状态。<br>heartbeat/nativeStatus门禁已废弃；替换为真实按钮证据及同一监听器持续工作的断言。 |
| F-101 | 身份与所有权 | `tests/native-activity.test.mjs:42`<br>NATIVE3 status ownership cannot cross tabs, leases or native turns | 状态输入不能越过会话、tab或观察lease的归属边界。<br>native user/turn不再是对话采集门禁；保留会话/文档/观察lease隔离。 |
| F-112 | 局部清单策略 | `tests/observation-recovery.test.mjs:151`<br>OBS-B1 /active inventory: recoveryOnly only for confirmed, observation-class failures | 观察绑定清单的入选/排除规则和DTO字段；HTTP路由另有链路用例。<br>移除recoveryOnly/outcome分类门禁；待归档意图尚未完成时仍应观察。 |
| F-120 | 身份与所有权 | `tests/observation-recovery.test.mjs:401`<br>OBS-C4 conversation may come from the observed URL; a disagreeing URL is refused | URL推导conversation与显式归属冲突的输入校验。<br>使用新观察重绑协议，不恢复recoverObservation旧执行路径。 |
| F-129 | 身份与所有权 | `tests/revision.test.mjs:19`<br>R02: late old-turn failure cannot terminate the next admitted turn | failTurn的expectedTurnId守卫；旧调用不能终止新接纳的请求。<br>需迁移驱动并保留正、负向断言；尚未确认实现已正确。 |
| F-136 | 局部展示映射 | `tests/revision.test.mjs:138`<br>R19: permission and unknown-final notices stay distinct | 等待/授权/结果不确定原因的事件区分，不应互相冒充。<br>旧waiting事件已移除，验证新来源问题/授权通知的区分，不能让正文完整度决定运行状态。 |
| F-146 | 局部展示映射 | `tests/ui-copy.test.mjs:166`<br>COPY image messages distinguish a generated image from an unavailable or loading preview | 单个图片renderer的文案，不涉及真实下载链路。<br>查看原图旧文案已纠正为打开原对话；不能为了通过恢复误导文字。 |
| F-147 | 局部展示映射 | `tests/ui-copy.test.mjs:189`<br>COPY provider notices do not infer page execution, completion or approval outcome | Provider通知与错误文案映射，broker事件在此测试中直接注入。<br>用现行事件驱动，不得从授权框关闭猜Allow/Deny，不得从正文缺失猜网页是否运行。 |

其中：
- CM-R10固定16条容量、OBS-B1旧recoveryOnly筛选、GAP3旧nativeStatus/heartbeat门禁属于**旧规则需重述**，不是建议把旧实现恢复。
- COPY图片“查看原图”的旧断言不能拿来恢复误导文案，原动作只是打开对话。
- 身份/归属负向用例必须先建立有效正向fixture，再改变一个字段，避免UNKNOWN_MESSAGE等入口失败造成假绿。
- 资源验证的局部通过不等于预览/下载全链成功；完整媒体链另列链路类。

## 123项链路类如何推进

不逐个修报错，而按以下闭环组织，每项保留编号对应关系：
1. **正文链45项**：公开来源/原始表示→传输/接收→账本/格式转换→原生投影，并核对修订、顺序、回执与错误隔离。
2. **绑定与生命周期链33项**：网页发起、Send/Stop、回执、缺口、重开、排队/容量释放；新旧观察身份及运行状态不能混淆。
3. **宿主交付/恢复链22项**：订阅屏障→暂存/发出→宿主观察→恢复/重放；特别处理冷窗口、旧binding和未确认尝试。
4. **过程/工具/状态链17项**：来源分型→独立通道→持久化/投影→Provider/显示，禁止状态错误改写真实工具结果。
5. **媒体链6项**：接收→字节存储→授权读取→资源卡/重读及生命周期；不以图片传输是否完成决定网页待命。

建议将24项作为独立局部队列，但不假设都很快；123项按上面的业务闭环验收。
保持已批准的正文主链优先级，不因为某些文案容易改就中断2B主线；局部规则在对应阶段作为前置/收尾处置。

## 按文件索引

| 测试文件 | 链路 | 局部 |
|---|---:|---:|
| `tests/append-only-production.test.mjs` | 7 | 0 |
| `tests/bidirectional-turns-adversarial.test.mjs` | 0 | 3 |
| `tests/bidirectional-turns-browser.test.mjs` | 1 | 2 |
| `tests/bidirectional-turns-http.test.mjs` | 1 | 0 |
| `tests/bidirectional-turns.test.mjs` | 6 | 0 |
| `tests/completed-message-http.test.mjs` | 1 | 0 |
| `tests/completed-message-observer.test.mjs` | 9 | 0 |
| `tests/completed-message-receiver.test.mjs` | 11 | 2 |
| `tests/content-observation.test.mjs` | 6 | 0 |
| `tests/conversation-binding.test.mjs` | 5 | 1 |
| `tests/host-observation-barrier.test.mjs` | 11 | 0 |
| `tests/images.test.mjs` | 6 | 4 |
| `tests/iteration.test.mjs` | 1 | 0 |
| `tests/late-browser-receipt.test.mjs` | 0 | 2 |
| `tests/lifecycle-timeouts.test.mjs` | 10 | 1 |
| `tests/message-receipt-integrity.test.mjs` | 2 | 0 |
| `tests/message-reconciliation.test.mjs` | 3 | 0 |
| `tests/monitor-gap.test.mjs` | 1 | 2 |
| `tests/monitor-ping.test.mjs` | 1 | 0 |
| `tests/native-activity.test.mjs` | 4 | 1 |
| `tests/native-timeline-sdk.test.mjs` | 1 | 0 |
| `tests/native-timeline.test.mjs` | 2 | 0 |
| `tests/observation-recovery-http.test.mjs` | 1 | 0 |
| `tests/observation-recovery.test.mjs` | 10 | 2 |
| `tests/page-observation.test.mjs` | 4 | 0 |
| `tests/public-prose-incident.test.mjs` | 2 | 0 |
| `tests/public-prose-regressions.test.mjs` | 1 | 0 |
| `tests/revision.test.mjs` | 7 | 2 |
| `tests/strict-regression.test.mjs` | 6 | 0 |
| `tests/sync-lanes.test.mjs` | 3 | 0 |
| `tests/ui-copy.test.mjs` | 0 | 2 |

## 全部147项逐条台账

第一失败点保存在JSON索引；下表为范围分配。文件行号是本次核查时的位置，不是稳定ID。
机器可读版本：`../logs/failure-scope-147.json`，含每项原错误、分类依据及迁移注意事项。

| 编号 | 范围 | 业务模块 | 定位 | 原用例名 |
|---|---|---|---|---|
| F-001 | 链路 | 正文采集、格式与修订 | `tests/append-only-production.test.mjs:111` | PROD same-ID updates keep one canonical final: equal re-reads are unchanged, late unfinished reads send nothing |
| F-002 | 链路 | 正文采集、格式与修订 | `tests/append-only-production.test.mjs:121` | PROD source object answer identities must never be deduped by equal prose |
| F-003 | 链路 | 正文采集、格式与修订 | `tests/append-only-production.test.mjs:130` | PROD source reference unavailable is never a placeholder or an empty successful body |
| F-004 | 链路 | 正文采集、格式与修订 | `tests/append-only-production.test.mjs:176` | PROD raw revision is isolated to its message, retained as an issue, never fake final |
| F-005 | 链路 | 正文采集、格式与修订 | `tests/append-only-production.test.mjs:189` | PROD stale shorter native read during or after generation does not override the canonical body |
| F-006 | 链路 | 正文采集、格式与修订 | `tests/append-only-production.test.mjs:207` | PROD end-to-end sourceFor -> real Broker message entry -> real Provider -> host -> replay |
| F-007 | 链路 | 正文采集、格式与修订 | `tests/append-only-production.test.mjs:276` | PROD real content observe -> Broker retains page facts and observation after a prose failure |
| F-008 | 局部 | 绑定、发送与生命周期 | `tests/bidirectional-turns-adversarial.test.mjs:21` | ADV1-01: a duplicate native user id may never silently change body or document |
| F-009 | 局部 | 绑定、发送与生命周期 | `tests/bidirectional-turns-adversarial.test.mjs:31` | ADV1-02: a second tab must not steal an extant conversation binding |
| F-010 | 局部 | 绑定、发送与生命周期 | `tests/bidirectional-turns-adversarial.test.mjs:38` | ADV1-03: durable native id is mandatory for external-gap notices |
| F-011 | 局部 | 绑定、发送与生命周期 | `tests/bidirectional-turns-browser.test.mjs:34` | TURN-W1: idle ChatGPT page identifies only a NEW anchored user, without sending a message |
| F-012 | 链路 | 绑定、发送与生命周期 | `tests/bidirectional-turns-browser.test.mjs:96` | TURN-W2: Chrome worker forwards native user event, never queues a second Send |
| F-013 | 局部 | 绑定、发送与生命周期 | `tests/bidirectional-turns-browser.test.mjs:109` | TURN-W3: worker declines conflicting routes and unverified candidates |
| F-014 | 链路 | 绑定、发送与生命周期 | `tests/bidirectional-turns-http.test.mjs:10` | TURN-HTTP: authenticated idle observation imports once, wakes once and never enqueues Send |
| F-015 | 链路 | 绑定、发送与生命周期 | `tests/bidirectional-turns.test.mjs:22` | TURN-A: a browser native user message starts Paseo autonomous events without issuing Send |
| F-016 | 链路 | 绑定、发送与生命周期 | `tests/bidirectional-turns.test.mjs:53` | TURN-B: external turn enforces original conversation, exact anchor, owner and idle state |
| F-017 | 链路 | 绑定、发送与生命周期 | `tests/bidirectional-turns.test.mjs:71` | TURN-C: running turn configuration is durable but only applied after native finish |
| F-018 | 链路 | 绑定、发送与生命周期 | `tests/bidirectional-turns.test.mjs:90` | TURN-D: native Paseo settings accept an active turn with next-turn tool selection |
| F-019 | 链路 | 绑定、发送与生命周期 | `tests/bidirectional-turns.test.mjs:128` | TURN-F: a cold Paseo Provider restores an imported browser turn by persistence |
| F-020 | 链路 | 绑定、发送与生命周期 | `tests/bidirectional-turns.test.mjs:149` | TURN-G: switching pending tools back to active settings clears the deferred change |
| F-021 | 链路 | 正文采集、格式与修订 | `tests/completed-message-http.test.mjs:14` | CM-HTTP1 receipts over /event: stored, unchanged after restart, rejected, malformed and unauthenticated |
| F-022 | 链路 | 正文采集、格式与修订 | `tests/completed-message-observer.test.mjs:43` | CM observer: approval waiting does not hide an already completed message or grant permission |
| F-023 | 链路 | 正文采集、格式与修订 | `tests/completed-message-observer.test.mjs:50` | CM observer: pending prose is not sent; page/activity remain live, completed commentary need not wait for turn end |
| F-024 | 链路 | 正文采集、格式与修订 | `tests/completed-message-observer.test.mjs:57` | CM observer: completed final-channel body is delivered before the task ends, then task completion reuses its receipt |
| F-025 | 链路 | 正文采集、格式与修订 | `tests/completed-message-observer.test.mjs:64` | CM observer: raw DIL goes to receiver unmodified and final uses its revision receipt |
| F-026 | 链路 | 正文采集、格式与修订 | `tests/completed-message-observer.test.mjs:71` | CM observer: receiver rejection is not a delivery confirmation or successful turn |
| F-027 | 链路 | 正文采集、格式与修订 | `tests/completed-message-observer.test.mjs:76` | CM observer: stored A after rejected B is re-confirmed under the same identity, not merely cleared from a cache |
| F-028 | 链路 | 正文采集、格式与修订 | `tests/completed-message-observer.test.mjs:84` | CM observer: lost receipt retries same message identity, never native Send |
| F-029 | 链路 | 正文采集、格式与修订 | `tests/completed-message-observer.test.mjs:88` | CM observer: pending earlier prose does not let a later tool row overtake native order |
| F-030 | 链路 | 正文采集、格式与修订 | `tests/completed-message-observer.test.mjs:94` | CM observer: confirmed native Stop flushes visible interrupted text instead of dropping it |
| F-031 | 链路 | 正文采集、格式与修订 | `tests/completed-message-receiver.test.mjs:30` | CM-R1 a complete message is stored once, durably, with a truthful receipt and turn metadata |
| F-032 | 链路 | 正文采集、格式与修订 | `tests/completed-message-receiver.test.mjs:53` | CM-R2 the same native message and revision is idempotent, also after a restart and observer rebind |
| F-033 | 链路 | 正文采集、格式与修订 | `tests/completed-message-receiver.test.mjs:71` | CM-R3 DIL is decoded once on the receiver; the revision covers the raw public string |
| F-034 | 链路 | 正文采集、格式与修订 | `tests/completed-message-receiver.test.mjs:81` | CM-R4 a real revision of a delivered message is rejected, kept as an issue, and never final success |
| F-035 | 链路 | 正文采集、格式与修订 | `tests/completed-message-receiver.test.mjs:97` | CM-R5 legacy streamed history: equal is unchanged, a prefix is completed in place, a conflict is rejected |
| F-036 | 局部 | 正文采集、格式与修订 | `tests/completed-message-receiver.test.mjs:111` | CM-R6 bounded, strict validation; identity mismatches never become receipts |
| F-037 | 链路 | 正文采集、格式与修订 | `tests/completed-message-receiver.test.mjs:135` | CM-R7 completion still needs the native terminal and the matching delivered final revision |
| F-038 | 链路 | 正文采集、格式与修订 | `tests/completed-message-receiver.test.mjs:154` | CM-R8 after a CONFIRMED Stop, the last visible part is recorded as interrupted without reopening the turn |
| F-039 | 链路 | 正文采集、格式与修订 | `tests/completed-message-receiver.test.mjs:175` | CM-R9 no late body for unproven stops, CIP errors, settled turns or superseded turns |
| F-040 | 局部 | 正文采集、格式与修订 | `tests/completed-message-receiver.test.mjs:204` | CM-R10 per-turn message capacity is reported, not thrown and not terminal |
| F-041 | 链路 | 正文采集、格式与修订 | `tests/completed-message-receiver.test.mjs:212` | CM-P1 Provider emits one exact native assistant item per stored message; host stays unconfirmed |
| F-042 | 链路 | 正文采集、格式与修订 | `tests/completed-message-receiver.test.mjs:235` | CM-P2 Provider forwards an interrupted body for a stopped turn without a new turn lifecycle |
| F-043 | 链路 | 正文采集、格式与修订 | `tests/completed-message-receiver.test.mjs:252` | CM-R11 the legacy snapshot lane cannot alter a body delivered by the message lane |
| F-044 | 链路 | 正文采集、格式与修订 | `tests/content-observation.test.mjs:42` | observer sends every completed prose item and tool in source order, stops before a pending message, never only the last answer |
| F-045 | 链路 | 正文采集、格式与修订 | `tests/content-observation.test.mjs:53` | a pending earlier message holds later tool rows, but the activity card stays live |
| F-046 | 链路 | 正文采集、格式与修订 | `tests/content-observation.test.mjs:59` | page facts keep flowing when prose/anchor is unavailable; no native Stop or Send |
| F-047 | 链路 | 正文采集、格式与修订 | `tests/content-observation.test.mjs:67` | an unreadable completed message is a visible issue, never an empty successful body or completion |
| F-048 | 链路 | 正文采集、格式与修订 | `tests/content-observation.test.mjs:76` | only a stored/unchanged receipt with the same revision counts; a rejected revision blocks completion |
| F-049 | 链路 | 正文采集、格式与修订 | `tests/content-observation.test.mjs:85` | a recovery descriptor resumes observation only after exact anchor proof, without replaying a command |
| F-050 | 链路 | 绑定、发送与生命周期 | `tests/conversation-binding.test.mjs:52` | LINK4 confirmed send followed by binding loss ends one turn but retains its usable link |
| F-051 | 链路 | 绑定、发送与生命周期 | `tests/conversation-binding.test.mjs:63` | LINK5 authenticated browser heartbeat keeps a linked running turn beyond its nominal timeout |
| F-052 | 局部 | 绑定、发送与生命周期 | `tests/conversation-binding.test.mjs:73` | LINK6 a foreign tab cannot renew a turn by pretending to be alive |
| F-053 | 链路 | 绑定、发送与生命周期 | `tests/conversation-binding.test.mjs:79` | LINK7 after an uncertain second prompt, Ensure must not demand the stale first native user ID |
| F-054 | 链路 | 绑定、发送与生命周期 | `tests/conversation-binding.test.mjs:143` | LINK10 generic observation loss still clears its potentially stale reopen anchor |
| F-055 | 链路 | 绑定、发送与生命周期 | `tests/conversation-binding.test.mjs:154` | LINK11 a browser-origin Stop failure preserves its own proven user ID on reopen |
| F-056 | 链路 | 宿主交付与恢复 | `tests/host-observation-barrier.test.mjs:57` | HB-1 a fresh host session saves content locally and holds delivery until its barrier confirms subscription |
| F-057 | 链路 | 宿主交付与恢复 | `tests/host-observation-barrier.test.mjs:92` | HB-3 content and a terminal before the barrier are held, then delivered once in order; no stale started follows |
| F-058 | 链路 | 宿主交付与恢复 | `tests/host-observation-barrier.test.mjs:109` | HB-4 the host session that ended a Paseo foreground turn refuses recovery BEFORE any CIP state change (P1) |
| F-059 | 链路 | 宿主交付与恢复 | `tests/host-observation-barrier.test.mjs:147` | HB-4b a cold Broker (no host binding) and a replaced binding never inherit an old refusal |
| F-060 | 链路 | 宿主交付与恢复 | `tests/host-observation-barrier.test.mjs:160` | HB-5 closing or replacing the host session before the barrier drops the pending announcement safely |
| F-061 | 链路 | 宿主交付与恢复 | `tests/host-observation-barrier.test.mjs:218` | HB-8 no failure reason is a subscription proof: AGENT_NOT_FOUND, NO_HOST_WAKER, invalid ID all keep the backlog undelivered and retrying |
| F-062 | 链路 | 宿主交付与恢复 | `tests/host-observation-barrier.test.mjs:236` | HB-9 more than 512 updates of one native ID are coalesced to its latest full snapshot, delivered once, before its terminal |
| F-063 | 链路 | 宿主交付与恢复 | `tests/host-observation-barrier.test.mjs:253` | HB-10 hundreds of distinct native IDs across many turns are all delivered once, each turn body before its terminal, no started for ended turns |
| F-064 | 链路 | 宿主交付与恢复 | `tests/host-observation-barrier.test.mjs:297` | HB-11 the complete Broker history budget fits the held identity queue without a second lossy limit |
| F-065 | 链路 | 宿主交付与恢复 | `tests/host-observation-barrier.test.mjs:340` | HB-12 confirmed-stop partial body arriving before subscription stays before its queued canceled terminal |
| F-066 | 链路 | 宿主交付与恢复 | `tests/host-observation-barrier.test.mjs:357` | HB-13 recovery before subscription replaces an obsolete tracking failure, not the original turn identity |
| F-067 | 链路 | 图片与界面文案 | `tests/images.test.mjs:10` | IMG1 image bytes are separate from timeline metadata; bounded RPC reads survive a fresh media object |
| F-068 | 链路 | 图片与界面文案 | `tests/images.test.mjs:11` | IMG2 image-only completion settles without fabricated assistant text |
| F-069 | 链路 | 图片与界面文案 | `tests/images.test.mjs:12` | IMG3 missing image transfer cannot be marked completed |
| F-070 | 链路 | 图片与界面文案 | `tests/images.test.mjs:13` | IMG4 retrying a received image is idempotent and another conversation cannot inject it |
| F-071 | 链路 | 图片与界面文案 | `tests/images.test.mjs:14` | IMG5 a failed preview has a visible unavailable card and can finish with native proof |
| F-072 | 局部 | 图片与界面文案 | `tests/images.test.mjs:15` | IMG6 images require exact native owner, public asset identity and native completion |
| F-073 | 局部 | 图片与界面文案 | `tests/images.test.mjs:16` | IMG7 MIME confusion, malformed bytes, excessive dimensions and oversized payload rejected |
| F-074 | 局部 | 图片与界面文案 | `tests/images.test.mjs:17` | IMG8 RPC cannot read media without the matching session and turn history |
| F-075 | 局部 | 图片与界面文案 | `tests/images.test.mjs:18` | IMG9 byte corruption and symlink replacement are refused |
| F-076 | 链路 | 图片与界面文案 | `tests/images.test.mjs:19` | IMG10 image completion cannot omit transferred siblings |
| F-077 | 链路 | 绑定、发送与生命周期 | `tests/iteration.test.mjs:21` | I02 duplicate first Send creates exactly one open and one native Send intent |
| F-078 | 局部 | 绑定、发送与生命周期 | `tests/late-browser-receipt.test.mjs:138` | LATE-9 same-page event during external-user read does not abort import discovery |
| F-079 | 局部 | 绑定、发送与生命周期 | `tests/late-browser-receipt.test.mjs:146` | LATE-10 actual A-B-A route departure still rejects pending identity |
| F-080 | 链路 | 绑定、发送与生命周期 | `tests/lifecycle-timeouts.test.mjs:19` | LIVE-T01: a clicked bound Send expires into monitoring, not a failed turn or a second Send |
| F-081 | 链路 | 绑定、发送与生命周期 | `tests/lifecycle-timeouts.test.mjs:35` | LIVE-T02: a verified live heartbeat lets a pending receipt survive arbitrary elapsed hours |
| F-082 | 链路 | 绑定、发送与生命周期 | `tests/lifecycle-timeouts.test.mjs:45` | LIVE-T03: exact recovered user UUID resumes native tool and final observation |
| F-083 | 局部 | 绑定、发送与生命周期 | `tests/lifecycle-timeouts.test.mjs:60` | LIVE-T04: wrong lease, tab, route or layout identity cannot recover pending delivery |
| F-084 | 链路 | 绑定、发送与生命周期 | `tests/lifecycle-timeouts.test.mjs:109` | LIVE-T08: restart preserves exact running and pending browser turn identities without replay |
| F-085 | 链路 | 绑定、发送与生命周期 | `tests/lifecycle-timeouts.test.mjs:120` | LIVE-T09: a stale observation gap never forges liveness or a completion |
| F-086 | 链路 | 绑定、发送与生命周期 | `tests/lifecycle-timeouts.test.mjs:131` | LIVE-T10: genuine prolonged loss of all verified browser activity still triggers a local error |
| F-087 | 链路 | 绑定、发送与生命周期 | `tests/lifecycle-timeouts.test.mjs:141` | LIVE-T11: a queued prompt does not expire merely because another tab keeps working |
| F-088 | 链路 | 绑定、发送与生命周期 | `tests/lifecycle-timeouts.test.mjs:155` | LIVE-T12: Provider connection close/reopen does not Stop a verified native turn |
| F-089 | 链路 | 绑定、发送与生命周期 | `tests/lifecycle-timeouts.test.mjs:181` | LIVE-T13: after claim, browser RPC timeout retains a bound authorized attempt instead of failing |
| F-090 | 链路 | 绑定、发送与生命周期 | `tests/lifecycle-timeouts.test.mjs:215` | LIVE-T15: a stopping native turn may safely rebind after document replacement |
| F-091 | 链路 | 正文采集、格式与修订 | `tests/message-receipt-integrity.test.mjs:5` | message receipt: an old interrupted revision cannot certify a later completed final |
| F-092 | 链路 | 正文采集、格式与修订 | `tests/message-receipt-integrity.test.mjs:14` | message receipt: equivalent COMPLETE representations can be recognized without a second body |
| F-093 | 链路 | 正文采集、格式与修订 | `tests/message-reconciliation.test.mjs:7` | reconcile: re-reading the stored complete version resolves its rejection without a second body |
| F-094 | 链路 | 正文采集、格式与修订 | `tests/message-reconciliation.test.mjs:22` | reconcile: citing an old receipt alone cannot clear a rejected source revision |
| F-095 | 链路 | 正文采集、格式与修订 | `tests/message-reconciliation.test.mjs:30` | reconcile: positive proof for one message cannot clear another or an unknown/status failure |
| F-096 | 链路 | 绑定、发送与生命周期 | `tests/monitor-gap.test.mjs:45` | NATIVE-GAP1 same document keeps monitoring when a tool hides the native user for >15 seconds |
| F-097 | 局部 | 绑定、发送与生命周期 | `tests/monitor-gap.test.mjs:69` | NATIVE-GAP2 A→B→A browser navigation invalidates a previously established monitor |
| F-098 | 局部 | 绑定、发送与生命周期 | `tests/monitor-gap.test.mjs:81` | NATIVE-GAP3 monitor heartbeat requires native in-progress evidence, not simply a live tab |
| F-099 | 链路 | 绑定、发送与生命周期 | `tests/monitor-ping.test.mjs:50` | TURN monitor pulse delivers the whole final body and an identity-bound completion when tab timers are throttled |
| F-100 | 链路 | 过程、工具与状态展示 | `tests/native-activity.test.mjs:24` | NATIVE2 observed native tool state goes into one replayable timeline card |
| F-101 | 局部 | 过程、工具与状态展示 | `tests/native-activity.test.mjs:42` | NATIVE3 status ownership cannot cross tabs, leases or native turns |
| F-102 | 链路 | 过程、工具与状态展示 | `tests/native-activity.test.mjs:54` | NATIVE4 completed terminal updates the same card and does not fabricate prose |
| F-103 | 链路 | 过程、工具与状态展示 | `tests/native-activity.test.mjs:68` | NATIVE5 failed turn marks activity card failed; no fake completion |
| F-104 | 链路 | 过程、工具与状态展示 | `tests/native-activity.test.mjs:79` | NATIVE6 Paseo Provider emits upserted timeline plugin item and final update |
| F-105 | 链路 | 过程、工具与状态展示 | `tests/native-timeline-sdk.test.mjs:11` | TIMELINE-SDK: the installed Paseo Provider validates actual native reasoning/tool calls and endings |
| F-106 | 链路 | 过程、工具与状态展示 | `tests/native-timeline.test.mjs:61` | TIMELINE-04: broker native tool cards are upserted per callId with streamed status and reasoning |
| F-107 | 链路 | 过程、工具与状态展示 | `tests/native-timeline.test.mjs:95` | TIMELINE-05: Paseo emits NATIVE reasoning and tool_call, retaining distinct identities |
| F-108 | 链路 | 宿主交付与恢复 | `tests/observation-recovery-http.test.mjs:46` | OBS-HTTP1 /active lists recoveryOnly bindings; /recover-observation rejects identity drift and is idempotent |
| F-109 | 链路 | 宿主交付与恢复 | `tests/observation-recovery.test.mjs:78` | OBS-D1 a pure content collection failure is non-terminal sync blockage, not idleness |
| F-110 | 链路 | 宿主交付与恢复 | `tests/observation-recovery.test.mjs:110` | OBS-D2 Broker refuses a non-prefix published answer and never reports it completed |
| F-111 | 链路 | 宿主交付与恢复 | `tests/observation-recovery.test.mjs:128` | OBS-D3 an explicit native terminal ends a blocked turn honestly; TURN_CHANGED stays terminal without claiming Stop |
| F-112 | 局部 | 宿主交付与恢复 | `tests/observation-recovery.test.mjs:151` | OBS-B1 /active inventory: recoveryOnly only for confirmed, observation-class failures |
| F-113 | 链路 | 宿主交付与恢复 | `tests/observation-recovery.test.mjs:190` | OBS-C1 incident A recovers the SAME old session: proof-gated, idempotent, no Send, history intact |
| F-114 | 链路 | 宿主交付与恢复 | `tests/observation-recovery.test.mjs:238` | OBS-C2 incident B (TURN_CHANGED, anchor still latest) recovers; a non-prefix answer is refused, never success |
| F-115 | 链路 | 宿主交付与恢复 | `tests/observation-recovery.test.mjs:255` | OBS-C3 a newer native user turn makes the old failure unrecoverable |
| F-116 | 链路 | 宿主交付与恢复 | `tests/observation-recovery.test.mjs:263` | OBS-T1 timeline overflow and non-prefix reasoning are recorded, never thrown to block the answer |
| F-117 | 链路 | 宿主交付与恢复 | `tests/observation-recovery.test.mjs:306` | OBS-P1 host capability gate: original turnId recovery must settle without prompt or duplicate text |
| F-118 | 链路 | 宿主交付与恢复 | `tests/observation-recovery.test.mjs:351` | OBS-P2 host capability gate: reopened original turn must settle after prior foreground failure |
| F-119 | 链路 | 宿主交付与恢复 | `tests/observation-recovery.test.mjs:381` | OBS-P3 Provider shows sync blockage once, keeps the turn open, and never ends it |
| F-120 | 局部 | 宿主交付与恢复 | `tests/observation-recovery.test.mjs:401` | OBS-C4 conversation may come from the observed URL; a disagreeing URL is refused |
| F-121 | 链路 | 过程、工具与状态展示 | `tests/page-observation.test.mjs:63` | PAGE-A2 page_status works without readable prose, updates one card in place and is not a terminal |
| F-122 | 链路 | 过程、工具与状态展示 | `tests/page-observation.test.mjs:85` | PAGE-A3 page_status continues after sync blockage and on a recoverable failed turn only |
| F-123 | 链路 | 过程、工具与状态展示 | `tests/page-observation.test.mjs:107` | PAGE-A4 Provider upserts the same card; inactive page status is shown without restarting a turn |
| F-124 | 链路 | 过程、工具与状态展示 | `tests/page-observation.test.mjs:129` | PAGE-A5 without timeline.plugin the page original text still reaches the chat as a notice |
| F-125 | 链路 | 正文采集、格式与修订 | `tests/public-prose-incident.test.mjs:141` | incident: unfinished representation changes are not locked in; a delivered body revision is refused at the Broker |
| F-126 | 链路 | 正文采集、格式与修订 | `tests/public-prose-incident.test.mjs:177` | incident: observation failure is not proof that the native task has stopped |
| F-127 | 链路 | 正文采集、格式与修订 | `tests/public-prose-regressions.test.mjs:102` | prose: a delivered body that later changes stays refused at the receiver, also for a later extension |
| F-128 | 链路 | 绑定、发送与生命周期 | `tests/revision.test.mjs:8` | R01: duplicate Stop shares one command and final observation settles both waiters |
| F-129 | 局部 | 绑定、发送与生命周期 | `tests/revision.test.mjs:19` | R02: late old-turn failure cannot terminate the next admitted turn |
| F-130 | 链路 | 绑定、发送与生命周期 | `tests/revision.test.mjs:39` | R05: final-slot admission reserves all supported response fragments |
| F-131 | 链路 | 绑定、发送与生命周期 | `tests/revision.test.mjs:48` | R06: excessive response fragmentation terminates with a recorded limit, never a running loop |
| F-132 | 链路 | 绑定、发送与生命周期 | `tests/revision.test.mjs:59` | R08: aggregate answer cap preserves history and a terminal failure |
| F-133 | 链路 | 绑定、发送与生命周期 | `tests/revision.test.mjs:66` | R09: proven document reload only rebinds observation, without another Send |
| F-134 | 链路 | 绑定、发送与生命周期 | `tests/revision.test.mjs:79` | R11: a missing browser binding blocks exactly its own turn, without a fictitious live URL |
| F-135 | 链路 | 绑定、发送与生命周期 | `tests/revision.test.mjs:106` | R15: updated context is sent as explicit user-level text on the next existing conversation turn |
| F-136 | 局部 | 绑定、发送与生命周期 | `tests/revision.test.mjs:138` | R19: permission and unknown-final notices stay distinct |
| F-137 | 链路 | 过程、工具与状态展示 | `tests/strict-regression.test.mjs:10` | STRICT-A01: only terminal confirmation can turn activity into completed |
| F-138 | 链路 | 过程、工具与状态展示 | `tests/strict-regression.test.mjs:22` | STRICT-A02a: lost browser updates the activity card before end |
| F-139 | 链路 | 过程、工具与状态展示 | `tests/strict-regression.test.mjs:31` | STRICT-A02b: failTurn, watchdog, reboot persist terminal card |
| F-140 | 链路 | 过程、工具与状态展示 | `tests/strict-regression.test.mjs:37` | STRICT-A02d: Runtime recover retains verified active turn and current activity |
| F-141 | 链路 | 过程、工具与状态展示 | `tests/strict-regression.test.mjs:47` | STRICT-A02e: actual timeout watchdog marks active timeline card failed |
| F-142 | 链路 | 过程、工具与状态展示 | `tests/strict-regression.test.mjs:57` | STRICT-A02c: successful Stop produces final activity, not a live tool |
| F-143 | 链路 | 正文采集、格式与修订 | `tests/sync-lanes.test.mjs:7` | SYNC page-carried prose issues affect health, and another message cannot clear their ownership |
| F-144 | 链路 | 正文采集、格式与修订 | `tests/sync-lanes.test.mjs:16` | SYNC status delivery failure is not repaired by prose; fresh status delivery repairs its own lane |
| F-145 | 链路 | 正文采集、格式与修订 | `tests/sync-lanes.test.mjs:26` | SYNC terminal tracking does not invent a native tool cancellation or erase its visible detail |
| F-146 | 局部 | 图片与界面文案 | `tests/ui-copy.test.mjs:166` | COPY image messages distinguish a generated image from an unavailable or loading preview |
| F-147 | 局部 | 图片与界面文案 | `tests/ui-copy.test.mjs:189` | COPY provider notices do not infer page execution, completion or approval outcome |

覆盖自检：147项各出现一次；123+24=147；所有局部选择均唯一匹配；31个文件计数与原失败清单一致。
