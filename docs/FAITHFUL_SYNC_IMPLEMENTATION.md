# 保真同步实施进展（未交付）

2026-10-17；接手分支 `fix/chatmode-timeline-duplicates`。

**仍在离线实现，统一验收未完成，两个真实故障 Agent 未恢复。没有部署、提交、推送或操作现场。**

未发布候选：插件 `0.1.0-alpha.4.20`、扩展 `0.2.26`、桥协议 **7**，MAIN正文IPC **v2**。用户已升级Paseo至0.12.0-beta.1；线上插件仍alpha.4.16并因旧范围拒绝加载，本候选未安装。SDK已对齐新版，manifest只新增精确beta.1准入，见 [新版兼容核查](PASEO_012_COMPATIBILITY.md)。中间候选.17/.18/.19均未部署。

## 消息级完整交付

用户授权的是 **每条原生消息完结后整体提交**，不是等整个任务结束。消息完成、原生任务结束、本机保存、Provider 发出、宿主保存/显示分别证明。

1. `cos-shell-public.js` / `cos-picker-main.js`：验证身份及公开来源，先排除结构证明的下级副本，保留 text/DIL 原表示、原生完成、可读性、用户归属和源位置。Chrome 不解码正文、不维护跨帧语法状态。
2. MAIN 请求/回应使用独立 v2 通道；不调用残留 v1 reader，不从旧 final 或缺字段猜消息 complete。缺格式/完成/可读性证据时不发布。
3. `dom-adapter.js`：消息读取、发送回执观察与模型菜单实现解耦；缺锚点不等于换轮，只有实际更晚用户才是 `TURN_CHANGED`。
4. `content.js`：pending 不发；每条 completed 立即整条发送，**包括 final_answer 频道**。该频道的消息 completed 不需要等 turn complete；后者仍是任务终态的必要条件。等待批准不挡住已完成正文，也不自动批准。
5. `shared/public-prose.mjs`：接收端对完整 DIL 一次 CoS 格式适配，普通 text 原样保留；格式、Unicode、容量和空正文分别拒绝。
6. `server/message-delivery.mjs`：沿用 `assistant:<turnId>:<nativeMessageId>`，SHA-256 只做版本对账。同版本幂等，历史前缀可补齐；已发表完整正文的真正修订拒绝并留问题，不追加第二份全文。
7. 回执失踪只重交数据，不重发原生 Send。A 已存→B 拒收→当前重读并重交 A，才可精确清除该消息问题；旧 receipt 或 completed 引用旧 revision 不能替代当前重交。其他消息、未知归属及状态通道问题不被清掉。
8. 任务 completed 要求原生终态和当前完整已存 `finalRevision`；旧 interrupted alias 不能认证完整最终版本。
9. 确证 Stop 后补可读半段为 interrupted，保留原 ID 和 canceled。未确认 Stop、断连、按钮消失均不构成中断证明。

```js
{ accepted: true, active, receipt: {
  messageId, revision,
  disposition: 'stored' | 'unchanged' | 'rejected',
  host: 'unconfirmed', code?
} }
```

**这是本机接收/落盘回执，不是宿主数据库或 UI 确认。**

## 已做的减法及独立通道

- 删除生产 `extension/public-prose-main.js` 和 manifest 接线；旧代码仅冻结在 HISTORICAL 测试夹具。删除逐字语法状态、半行/公式跨帧修补及静默完成计时。
- 保留配对、绑定、权限、命令 ledger、防重复 Send、队列和停止确认。浏览器仍有必要待交付状态，不宣称零状态、净删行数或性能百分比。
- 公开嵌套 commentary 保留；隐藏父组、analysis、私有 recipient/参数不导出。局部坏消息不清空整页。
- `page_status` 独立采集原生执行、可见提示/作用范围、按钮原文及可用性；正文异常不阻断状态。脱敏/截断明示，不点击 Retry/Send/Stop。
- 源位置用于批次排序，前序 pending 正文阻止后续条目越位，活动卡仍独立实时；不等于已解决任意历史插入或所有媒体/工具源序。
- 跟踪结束保留工具最后可见状态/详情并标当前未确认，不伪造原生 canceled。

## 导航与恢复

- **导航走不是关闭**：现存 tab 或 pendingUrl 指向另一会话，拒绝 `WRONG_CONVERSATION`，不另开标签发送、不 claim/authorize。tabs.get 失败后需枚举证明确实已关闭；枚举失败、URL 不可读或 tab 仍在均拒绝。确证关闭的正常重开保留。单测和隔离 MV3 已通过。
- **旧连接已终结的前台轮次**：恢复在写盘、占槽和改状态前拒绝 `OBSERVATION_HOST_SESSION_REOPEN_REQUIRED`；不先假恢复 running，也不自动 Send/Stop。安全拒绝不是恢复成功，OBS-P1 能力门禁仍红。
- **新宿主 binding**：共享的显式 `host-observation` 对象接入 Provider/wake/index；每个 binding 使用自己的新 commands 请求。失败、旧连接回执、替换后的回执都不放行。open 不等待自己的屏障，避免死锁。
- **订阅前内容/终态**：ready 后、屏障前按稳定条目 ID 保存有序完整快照，同 ID 更新原位替换；固定 notice ID 更新同槽。容量受 Broker 已允许的持久化身份/载荷及固定标记约束，不另设512条或3064条丢弃阈值。满1000历史行的实际 Broker 路径已验证正文和工具全部交付。Store 的32MB是序列化限制，不是 JS Map 堆内存精确上限。
- **释放顺序**：只有仍在运行的轮次才 started；已完成轮次只交内容和真实终态，不伪造 started 清错。确证 Stop 后迟到的正文插到尚未释放的 canceled 之前。屏障前已有强证明恢复的跟踪失败不再作为过期 failed 重放；八次同 ID 恢复仍只开始/结束一次。
- **禁止盲目重载**：CIP running 时 session.close 实测会发 Stop；原 Agent 需在重新确认安全后明确重建宿主会话，不是刷新网页或重发任务。插件未自动重开，真实现场未操作。

### 新发现的宿主并发硬门禁

**订阅成功不等于可以安全交付旧轮内容。** 原版0.11.4在新提示 pending 期间暂存所有事件，接受新提示后先写新 user 再回放；旧正文会排在新 user 后并被归到新 turnId。新提示失败时，这些暂存事件直接丢弃。

已在原版0.11.4和0.12.0-beta.1完整类执行验证，不是窄模型推断：REAL-9 分别覆盖 Provider 收到新提示前/后，REAL-12 覆盖新提示失败。契约调整前均红；2026-10-17 用户确认按到达顺序显示、归轮为已知限制，插件侧在准备新提示期间暂存旧内容，失败后再交付，现两版均13/13通过。调整前：真实 SDK messageId 仍保留旧 ID，但宿主归轮/顺序错误或正文缺失。详细根因与接口缺口见 [HOST_CONCURRENT_DELIVERY_GATE.md](HOST_CONCURRENT_DELIVERY_GATE.md)。

不能只补 flush、再等一次 commands、用延时或伪造 started 消掉红项。拒绝可见碰撞只是局部止损且改变已有排队行为，也不能覆盖宿主已 pending、Provider 尚未收到请求的窗口；当前未擅自更改这项行为。两位只读审查者在原版实测后结论一致：当前公开 API 缺少原子前置栅栏或带归属/源序的历史交付能力，不能 Provider-only 完整修复。

## 最新验证（不是发布验收）

- 新版环境默认套件：**504项，503通过、1失败OBS-P1、0skip**；`../logs/paseo-012-full-final.log`。历史500/499、476/474等结果不替代本轮。
- 原版完整宿主类：**13项，10通过、3失败、0skip**；REAL-9两个并发窗口及REAL-12失败丢失为红，`paseo-012-real-0.12.0-beta.1.log`及旧版对照`paseo-012-real-0.11.4.log`。REAL1–8、10、11通过，包括真正reload lane、正文/终态早到、过期failed及Stop半段排序。
- 选定 **21个隔离浏览器/MV3全部通过**：15普通Chromium、6MV3；`paseo-012-browser.tsv`、`paseo-012-mv3.tsv`。不是全部浏览器脚本或真实账号验收。
- check、verify:upstream **13来源**、typecheck、SDK **2/2**、diff check通过；`paseo-012-static-final.log`。新增实际Paseo准入校验4/4：旧范围确实拒绝新版，新范围只接纳已核查beta，SDK声明/实际版本一致。
- 原版mapper/renderer宿主能力诊断：**23项16通过7失败，0skip**；`paseo-012-diagnostics-final.log`。真实修订及机器尾段等红例保留。
- `completed-message-browser.py` 验证生产MAIN/ISOLATED/content→Store/Broker/Provider→原版mapper/renderer，包括 final频道消息先交、任务后结束；独立等待工具回执并断言源序、终态、隐私和唯一夹具启动Send。不是MV3/真实宿主生命周期验收。
- 测试环境包含固定来源和真实SDK schema；一次错误的SDK环境路径已更正为本地file URL。浏览器夹具不再把正文回执当成同批后续工具已落盘的证明，没有放宽生产规则。

## 仍需完成，不能包装成“已知限制即可发布”

- 两个原 Agent `37c5561f…`、`4a8efaf4…` 的历史缺失对账、回传和控制恢复，不能新建替代。
- 同连接前台已终结恢复、上述并发交付门禁，以及真实daemon/WebSocket/宿主持久化/显示对账。
- 旧半段历史、同ID Retry/真实修订、任意迟到历史插入、网页直接Stop、终态后观察。
- 媒体独立分支、完整工具详情与分页/容量；活动实时不代表全部内容完整。
- 宿主正文替换和工具穿插后的完整机器回报；不采用双正文或追加修订全文。
- 其余未跑浏览器场景及新的部署/现场操作授权。

没有修改安装的Paseo、删除/替换turnId或引入 `:observe:n`。当前不是可交付候选；宿主侧能力或排队契约变更必须另行确认，不把“继续离线开发”当作扩大授权。
