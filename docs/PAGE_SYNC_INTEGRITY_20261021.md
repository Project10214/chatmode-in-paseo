# 页面 → Paseo 同步链的三处修复（2026-10-21）

分支 `fix/page-to-paseo-sync-integrity`，基于 `fix/binding-refresh-manual-recovery`。插件 `0.1.0-alpha.4.46`、扩展 `0.2.51`、协议 CIP v9。

范围：**只处理「ChatGPT 页面采集到的内容如何同步到 Paseo」这一段**。发送、授权、恢复、归档与宿主并发交付门禁未改动。

## 1. 助手正文被冻结在首帧长度

**根因**：`extension/page-content.js` 把 `userMessageId` 算成「本次读取中最近一条**被成功识别**的用户消息」的游标——一个由页面环境决定的**位置相关**值。用户消息尚未挂载、被虚拟化卸载、或落在 `opacity:0` 的入场动画里时，这个值就会变。服务端 `server/source-ledger.mjs` 却把它列进 `IDENTITY`，于是 `conflicts()` 判定冲突，`reconcileSources` 直接 `continue`，**把整条更新连同增长的正文一起丢掉**。冲突每帧都成立，于是正文永久停在首帧长度，而轮次照常标记 `completed`。

**修复**：`userMessageId` 从硬身份降为**指针**。

- 硬身份只保留 `role / lane / kind / nativeMessageId / callId`，语义不变，仍然拒绝并保留首次版本。
- 指针变化时**保留首次引用**（归属不移动，避免活动卡按新引用重分裂），但**内容更新照常应用**，并单独记 `SOURCE_USER_MESSAGE_REVISED`（非致命，可在页面状态卡片看到）。

**验证**：`tests/source-ledger.test.mjs` LEDGER-12；`tests/page-to-paseo-sync.test.mjs` SYNC-01。

## 2. DOM 路径位移被读成正文改写，导致整段会话重投

**根因**：来源的 `order` 是 DOM 兄弟索引路径，却被计入内容修订号 `sourceRevision()`。网页顶部插入一个分隔线、React 重建 DOM、或 `roots()` 回退到 `document.body` 后 body 子节点增删，都会让**所有**来源的路径整体位移——正文一个字没动，账本却判成 `rewrite`，于是整段会话被重新投影，`order` 又嵌在卡片的 `data.source` / `metadata.source` 里，Provider 的整条 JSON 去重失效，**同一 id 的卡片被重复投递**。

**修复**：位置不是内容。

- `sourceRevision()` 不再包含 `order`。
- 只发生位移时，账本**静默刷新存储位置并重新排序**，不产生 change 事件，因此不重投影、不重投卡片。
- 内容真的变了时照旧产生 `append` / `rewrite`。

**验证**：`tests/source-ledger.test.mjs` LEDGER-13；`tests/page-to-paseo-sync.test.mjs` SYNC-02。

## 3. 传输分帧让「轮次完成」抢在正文前面

**根因**：一次页面读数超过 `MAX_FRAME_BYTES`（384KB）会被拆成多帧，而**每一帧都带同一份网页状态**。服务端在第一帧看到「待命」就 `closeRun` → 宿主 `session.turn` 报 completed，剩余正文在后面的帧才到达。

**修复**：一次读数是一个整体。

- 扩展在 `envelope` 里带出 `readFinal`，`framesOf` 只给这次读数的**最后一帧**标 `true`。
- 服务端只在 `readFinal !== false` 的帧上收尾轮次与 recovery standby。
- **向后兼容**：不带该字段按单帧读数处理，旧扩展行为不变。

**验证**：`tests/continuous-observation.test.mjs` CONTOBS-14 / CONTOBS-15；`tests/page-to-paseo-sync.test.mjs` SYNC-03。

## 本轮验证

- `npm test`：**810 项，809 通过，0 失败，1 跳过**（本轮新增 7 项：LEDGER-12/13、CONTOBS-14/15、SYNC-01/02/03）。
- `npm run check`、`npm run typecheck`、`npm run verify:upstream` 均通过。
- 修复前 803 项全绿**不构成任何信心**：旧测试从不改变 `userMessageId`、从不做 DOM 位移、从不产生多帧读数。

## 未修复 / 残留

- **扩展端游标没动**：`userMessageId` 仍由页面环境推导。服务端现在容忍它，但归属仍以**首次**读到的引用为准，那次首读若恰好落在用户消息不可见的窗口，归属会停在旧的一轮。彻底解决需要在扩展侧按轮次容器绑定用户消息。
- **宿主侧事件顺序**：正文经 `native-delivery` 异步投递，宿主的 `session.turn completed` 仍可能先于 `timeline.item` 到达。这属于既有的宿主并发交付边界（见 [HOST_CONCURRENT_DELIVERY_GATE.md](HOST_CONCURRENT_DELIVERY_GATE.md)），本轮未动。
- **DOM 本地 id 仍不稳定**：既无 `data-message-id` 也无 search-unit-key 的来源仍退回 DOM 路径 id，账本「从不因缺席删除来源」的规则会让位移后的旧 id 永久留存为重复条目。本轮只消除了「位移即改写」这一条放大路径。
- **浏览器回归未跑**：`tests/*.py` 需要 playwright，本机未安装，扩展侧真实行为仍需实机复核。
