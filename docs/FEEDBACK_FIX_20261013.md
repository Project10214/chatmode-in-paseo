# 配置页无反馈：2026-10-13 本地修订

## 判断

核对目标：Penn’s Mac，/Volumes/penndisk/HarnessSpace/Project10214/cos-in-paseo。

daemon.log 21:49:45 的目录尝试为 APP_MENU_TIMEOUT，stage=apps，editorCount=1、panelCount=0、rowCount=0；21:50:49 出现 Plugin RPC timed out: cos-in-paseo.invoke，21:50:54 才收到网页失败回执（耗时 34462ms）。这些记录证明请求进入了运行服务，但页面未被识别出应用菜单；长时间同步等待又超过宿主请求期限。后续现场也出现 BRIDGE_TIMEOUT。尚未有成功的完整目录，没有创建 Chatmode 工作会话。

CoS 来源：vendor/cos/README.md 和 provenance.json 记录 5 个函数级直接移植模块。输入/发送确认、控件、模型选择、Fiber 模型读取、公开正文/结束判断采用上游摘取代码并适配。background.js、content.js、dom-adapter.js、app-menu.js、popup.js 及 Paseo 服务端仍有本项目实现。不能称为原版 Chrome 扩展整体复制；特别是通用 @ 列表不是完整 CoS 现成实现。

## 执行

修改 server/diagnostics.mjs、shared/rpc.ts、client/settings.tsx。刷新改为立即返回“进行中”，由后续短请求读回结果，不让一个界面 RPC 等待整次浏览器采集。正在进行的目录尝试可以共享，不重复创建；增加等待时间、成功数量和失败说明。轮询同步完整 catalog，同时保护未保存的模型/应用选择。

原件备份：.local-backups/before-feedback-fix-20261013.tgz。本次未修改 Chrome 扩展、配对凭据、用户历史、账号设置；未修改 GitHub。版本清单仍为 alpha.3.1，本次是本地反馈修订，不冒充新发布。

## 检查

node --test tests/*.test.mjs：95/95 通过。新增 tests/feedback.test.mjs 的 4 项检查覆盖：慢网页不阻塞界面返回、晚到成功可轮询获得、晚到错误仍能看到、共享已有采集而不再开标签页。DIA2 改为验证新的“立即接受 + 稍后轮询失败”契约，不删除原失败条件。

npm run check：32 个 JavaScript 文件解析通过。npm run verify:upstream：5 个来源模块哈希通过。这不等于完整 SDK 类型检查或真实界面验收。

@ 应用菜单识别仍未解决。本次尝试只读网页检查时，Chrome 禁用了 AppleScript JavaScript；原生窗口采集也失败。未改变这些权限。唯一新开的诊断空白窗口已按窗口/标签身份关闭，没有发送任何模型消息。

使反馈修订生效：只重新加载 Paseo 的 cos-in-paseo 插件并重新打开配置页；Chrome 本轮未改，不要求重配对。当前不应继续反复刷新等待目录成功；必须继续核对原生 @ 菜单的实际页面结构，再验收完整链路。
