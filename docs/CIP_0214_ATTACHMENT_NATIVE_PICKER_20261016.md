# CIP Chrome 0.2.14 · ATTACHMENT_INPUT_AMBIGUOUS 再次复现与完整入口追踪修复（2026-10-16）

## 结果
**本地候选已修正，尚未生产部署。** 仅改 CoS in Paseo 的 Chrome 插件到 `0.2.14`；Paseo 插件 `0.1.0-alpha.4.7`、Provider 协议 v1、CIP v5、共享 Runtime 均保持不变。本次没有重载 Chrome、刷新已有绑定标签或重启正在运行的 Agent。

## 再次实机报错与原因
只读核查 `~/.cos-in-paseo/state.json`：2026-10-16 11:29（Asia/Taipei）出现一条新的 PNG 附件发送失败，约 395,374 字节；错误 `ATTACHMENT_INPUT_AMBIGUOUS`，命令 `failed`，**没有成功原生发送点击的证据**。旧 PNG 失败记录仍在；不能把“消息已排队，等待网页接收”当作实际送达。

前版 0.2.13 仍有两个缺口：
1. 当前 Composer 中若有两个类型和 `accept` 同等匹配的隐藏 file input，`uniqueInput` 直接抛错，**没有先询问当前 ChatGPT 上传菜单实际上激活哪一个**。这是此前测试没覆盖的场景。
2. 英文上传菜单正文字样 `Upload files` 在旧正则中漏了空格，故菜单可能存在，但匹配不到。

## 修复
- 严格从当前 Composer 的原生“添加文件”等按钮发起，识别英文 `Upload files` 等菜单项；原始手写聊天文字和其他页面不在范围内。
- 仅在该动作的短窗口内观察页面**真实向哪个 `input[type=file]` 发送 click**。Chrome 扩展隔离脚本捕捉事件并取消其默认系统文件选择窗口，再向被准确触发的唯一 input 写入已校验 SHA-256 的浏览器 File，并派发原生 input/change 事件。主世界 React 的常规 `input.click()` 和 `label for=input` 两种行为均涵盖。
- 其他表单、非当前 Composer、文件类型不兼容或并发的真人点击不被抢占；两个不同 input 都被触发，或菜单不能给出准确目标时仍安全拒绝，绝不按 DOM 顺序随便选。
- 错误时额外只传三个整数：当前表单 file input 数、表单外备选数、类型匹配数（复用现有安全诊断白名单）；不发送文件内容、名称、路径、私人聊天信息。
- 保留一次性网页 Send、会话身份/lease、附件真正展示并上传完成的校验。失败的旧消息不会自动重发。

## 验收范围
- 真实 Chrome **临时 MV3 扩展、隔离脚本**：3/3 PASS。含页面主世界 `input.click()`、`label` 默认激活及无证据同类型控件安全拒绝；**没有打开系统文件选择窗口、没有 ChatGPT Send**。
- 真实 Chrome 独立文件选择夹具：5/5 PASS（图片优先、PNG+PDF 分控件、同分拒绝、同分后按上传菜单选中正确入口、中文加号 portal）。
- 原生 PNG+PDF 传入及附件证据夹具：4/4 PASS。
- Node 全量回归与 SDK 检查：以本次最终回归输出为准；源码检查独立运行。
- 以上均是本机临时账号无登录的离线夹具。**没有已登录 ChatGPT 真正发送 PNG 的 PASS，因此 Presure COSINPASEO-7 保持 In Progress。**

## 部署 / 生产确认
1. 等当前所有 Chatmode Agent 和其他相关任务真正空闲；扩展升级可能刷新受管标签，不能中断已有网页工具调用。
2. 在 Chrome `chrome://extensions` 中重载 CoS in Paseo，**核对扩展版本 v0.2.14**；确认原来失败的受管 ChatGPT 页面已加载新版脚本，必要时仅在空闲时重新打开/刷新该对话。
3. 从同一个 Paseo Agent **显式发一条新消息**配一张 PNG（不要对旧 `failed` ID 自动补发），核对：原生附件确实出现、上传结束、Send 只触发一次、ChatGPT 原生用户消息 ID、答复和 Paseo 的最终状态。
4. 单张 PNG 通过后再测 PDF、图片+文档、多输入框和版本更新恢复。不能因离线通过宣称生产已修复。

重要边界：本机 Chrome 用户 Profile 的文件读取受 macOS 权限限制，**没有读到实际生产扩展的已加载版本**；候选源码版本不等于浏览器正在执行的脚本。