# 持续同步修复计划

状态：in_progress（2026-10-18；2B原始正文已接实际组件链，第一批部分完成；47项中2项等价替代通过、45项链路待迁移验收；跨epoch恢复、全量及实际UI仍未验收）。

## 范围与事实

- 仅候选工作树，由主线程执行；不安排subagent。
- 保留全部既有未提交修改；不重置、不从main重开、不提交/推送/部署。
- 不操作真实会话、网页Send/Stop或授权；真实环境验收需要另行授权。
- 基线：809项，638通过、171失败、0取消、0跳过。见工作树外`../logs/core-fixes-full-final.log`和`core-fixes-failure-index.json`。
- 171项涉及34个测试文件；按文件业务归属：绑定/发送/恢复70，正文47，宿主交付恢复24，过程状态18，媒体文案12。不是171个独立故障，也不是全部已定位的根因。
- 宿主读取适配器、native-delivery、原始正文读取和source-prose尚未全部进入生产链。模块通过不算功能完成。
- 媒体已修部分冻结，只防回归，不继续扩展。

## 全程不可违反的约束

- 正式回答保留原生assistant_message；过程按真实来源独立投影。
- 可见Stop决定运行；确认无Stop且Send/Voice可见才是待命；其余不能确认时是异常。
- 待命结束当前运行，不结束采集、授权或迟到内容接收。
- 原始来源、本地持久化、发送尝试、宿主投影观察相互独立。commands成功不是内容ACK；投影不是canonical事件或持久化ACK。
- 不自动重发用户任务，不自动允许/拒绝；补历史只读，不用Send恢复。
- 不引入broker.observe兼容壳，不恢复active/idle/recoveryOnly竞争采集路径。
- 不跳过、删除或放宽有效安全断言；旧语义必须记录其替代测试及理由。

## 1. 前置安全门：暴露真问题，不先追逐全绿

重点文件：tests/helpers.mjs、binding-observation、provider、lifecycle-timeouts、receipt-lifetime、conversation-binding相关测试。

- 为关键场景提供真实page-view、观察lease/document epoch和Send dispatch/receipt驱动；保留独立的负向身份输入。
- 给失败建立“原要求→现要求→入口阻塞或真实缺陷→替代验证”映射；重复问题在共享fixture修，不逐个复制补丁。
- 必验：跨会话拒绝、过期document拒绝、A→B→A不复活旧观察、重复prompt/取消不多发、迟到回执不改变已确认按钮状态。
- 首批只解锁上述关键验证，不要求70项全部迁完才进入正文闭环。

退出门槛：关键正负向场景通过；生产代码无旧接口兼容分支；全量无无法解释的新增失败。

阶段记录：第1步定向101/101；最新全量812项665通过/147失败/0跳过，相对基线无新增失败。发现并修复原生身份校验、未知送达提示、迟到回执状态覆盖、旧document回执回滚绑定问题。证据及需求映射见`../logs/safety-gate-summary.md`。不代表70项绑定/生命周期旧回归已全部迁完。

## 2. 第一核心交付：正式正文的生产闭环

目标：网页来源→来源账本→实际Provider→原生assistant消息→公开宿主投影核对。

### 2A. 先用纯文本打通真实Provider出口

重点文件：server/provider.mjs、host-observation.mjs、wake.mjs、native-delivery.mjs、host-timeline.mjs、index.server.ts；必要的checkpoint客户端注册。

- 先写组合回归，暴露“当前Provider未使用交付协调器”的缺口；不另写一个模拟Provider代替生产入口。
- 显式关联CIP session、Provider binding generation、实际Paseo Agent与host epoch；不得按标题/顺序猜Agent。
- 原生正文只走一个出口。交付尝试持久化后才发送；emit返回不视为宿主已收到。
- 正文与checkpoint经过同一有序出口；held/deferred阶段不允许marker越过正文。
- 处理checkpoint客户端渲染，不能留下“插件不可用”卡；不得把正式回答换成插件卡。
- 正向宿主观察可确认当前投影；仅在覆盖充分且同序checkpoint成立时修补已证明缺失的后缀。
- 覆盖不足、冷启动历史不全、准备阶段发送状态不明时，保留来源并报告待确认，不盲目补发。
- 生命周期与交付解耦：观察/待命/授权不等正文确认；关闭binding清理异步任务及订阅，旧回调不能写新binding。

退出门槛：生产Provider参与的组合测试覆盖普通增长、重复观察、先待命后正文、发送前/后丢失、checkpoint丢失；同一输入无重复正文/用户Send。原版宿主及公共SDK进程内链通过；不冒充实时IPC/UI验收。

阶段记录：2A已接实际Provider/生产wake与公共读取适配器，非仅独立协调器测试。生产Provider组合12/12、读取所有权7/7、原版宿主14/14；具体模拟边界见`../logs/provider-wiring-summary.md`。默认并发全量曾两次出现Broker文件累计15秒取消；并发4、同样15秒预算的最新全量831项684过/147失败/0取消/0跳过，未把两种运行配置混报。跨epoch/旧模糊attempt只报待确认，未声称冷恢复完成。

### 2B. 接入原始正文与格式转换

重点文件：extension/public-message-main.js、public-message-adapter.js、content.js、manifest.json、server/source-prose.mjs及实际来源投影入口。

- 只读已提交、可见、精确原生message ID对应的公开内容；不扫描全局私有缓存/推理。
- raw读取失败不阻塞DOM文字、状态、权限、其他来源；DOM文字标注真实表示，不能伪称原始Markdown。
- 接入已有增量转换器，保留每来源表示/解析状态，不等待全文完成。
- 核对修订、分段公式、Unicode、重读和重启；不得用全量正文重发掩盖宿主缓存缺口。

退出门槛：正常文字和Markdown/DIL都走2A同一出口；DOM/原始表示的边界有正负向测试，正式回答与Work展开相互独立。

第一批执行：原文补读/账本/增量转换已接同一Provider；Chromium至原版宿主/客户端reducer六组通过。修复发布前来源改变竞态与大补读令DOM永久pending问题。47项仅CM-R6/CM-R10完成新契约替代，其余45项仍待迁移验收。最新受控复跑840/695/145/0取消；前次受控PD-6超时，默认并发PD-1超时并有2文件取消，稳定性仍未解决。详见 `PROSE_2B_PROGRESS.md`，不可标记2B完成。

## 3. 恢复闭环与其余有效回归

- 在同一生产链加入断连重连、Provider重建、daemon冷恢复、同对话document替换和历史补齐。
- 检查持久化版本/恢复边界；未知prepared状态、缺失宿主覆盖不得解释为“从未发送”。
- 逐批迁移剩余正文、生命周期、过程/工具与宿主屏障测试，既有宿主限制单独报告，不算验收通过。
- 任意恢复必须保持会话身份、防重发、授权不被默认Deny、待命后继续同步。

退出门槛：新增恢复场景通过且源数据无静默丢失；每一批全量失败名录可解释，不能只汇报选中的绿色模块。

## 4. 收尾与验收

- 验证已有generated-image历史和generated-file新卡的兼容、安全读取、资源替换及真实下载流程。
- 按调用关系清理旧代码/manifest加载；保留仍承担Send、receipt、应用选择的必要依赖。
- 排查大单项传输及离线FIFO内存压力，超限必须可见，不允许静默截断。
- 跑完整Node、语法、类型、upstream核验、隔离Chromium和原版宿主检查。
- 实际SDK/IPC和UI验收另行申请授权；不以离线fixture替代。未满足验收条件保持in_progress，不部署。

## 节奏和止损

- 每批只解决一个核心闭环：先复现→最小实现改动→定向验证→全量核对→记录剩余阻塞。
- 产出以“生产链已完成的行为”衡量，测试数量仅是证据。失败数量减少不是唯一目标。
- 第一执行检查点预算最多1个有效工作日：完成前置安全门，给出2A真实Provider接线的组合证据或准确阻塞。
- 若2A需要再次大范围重写Broker/Provider、恢复双轨，或公开接口无法提供必要证据，立即停下报告，不继续堆补丁。
- 届时比较在已验证alpha.4.27基线上重组；不能默认本地alpha.4.15的main等价于线上基线。不会未经授权启动重建。
