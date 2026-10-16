# alpha.3.8：图片回传与双插件界面迭代

版本：Paseo `0.1.0-alpha.3.8`；Chrome 清单 `0.1.10`、显示版本 `0.1.0-alpha.3.8`；网页引擎 `cos-native-alpha3.8`。CIP 仍为 v3，Paseo Provider 仍为 v1。

开发目录：`/Volumes/penndisk/HarnessSpace/Project10214/cos-in-paseo`。本轮仅操作 Penn’s Mac 的本项目；未上传 GitHub，未重载用户浏览器或运行中的插件，未重发生成请求、删除历史、重置配对或解除旧会话阻断。

## 1. 图片如何从 CoS 接入

对照 CoS 提交 `e40562640361ca8f74158b2262ca8c555b00abed`：

- `extension/fiber.js:784–880` 的 `generatedImagesOf`：从公开的原生消息模型提取 messageId 与 sediment assetId，过滤用户上传、隐藏内容与分析内容。页面 URL 仅用于确认对应像素，不作为持久身份。
- `extension/fiber.js:2192–2275` 的 `shellTurnSource`：生成图必须由本轮原生 messageIds 命名；全部图片不再是预览、状态完成且父轮次完成，才能确认图片回答结束。
- `extension/content.js:4062–4217` 的 `nativeImageNode`、`captureNativeImage`：优先读取已加载的最大图片节点，在 canvas 上生成 WebP 预览。异步前后都重新核对图片、会话、节点与源像素归属。

新增 `extension/upstream/cos-images-main.js` 是上述函数级移植与适配，不是整个 CoS 记录器原封不动复制。来源、改动、加载世界与本地哈希在 `vendor/cos/provenance.json`，现有 9 个来源模块全部纳入检查。

图片通道：

```text
ChatGPT 原生消息／生成图身份
  → CoS 来源代码核验图片属于本轮
  → 从已加载图片像素生成 WebP 预览
  → Chrome 扩展提交 image 事件
  → Runtime 写入单独的 media 文件
  → Provider 发布轻量的 generated-image 图片卡片
  → Paseo 客户端通过现有认证 RPC 分块读取
  → 卡片预览、放大、网页原图入口
```

`blob:` 图片必须同时匹配原生 item、imageId、isComplete 与 isPreview，不能只凭附近有一张图就认领。普通资源只接受同源 estuary 路径、精确 assetId 与同一原生轮次。签名 URL、Cookie、授权头和任意工具输出不会从网页透传到 Paseo。

### 交付边界

本版接收的是 **WebP 压缩预览，不是原图文件**。最长边 1600 像素，单张预览最多 384,000 字节；每轮最多 8 张。卡片提供放大和“网页查看原图”。CoS 的 `exportNativeImage` 原图读取功能本版没有移植，不宣称能够在 Paseo 直接保存完整原图。

图片字节保存在 Runtime 状态目录的 `media/<sha256>.webp`，文件私有、按内容哈希验证，历史仅保存图片描述。客户端每次最多取 32,768 个 base64 字符，避免把图片嵌入有 64 KiB 限制的插件时间线条目。默认媒体总量上限 128 MiB；满额明确报错，不自动删除用户图片。无公网图片接口、无任意路径读取、无新扩展权限。

预览暂未加载时有界等待约 15 秒；仍无法读取时返回明确的“预览未能读取”卡片。如果网页原生轮次已经完成，可以结束该轮，不再无限等待一个不存在的文字 final。没有原生完成证据则不伪造完成。文字与图片混排时先完成图片交付，旧图片不会结束后续新轮次。

## 2. 界面变化

### Chrome 扩展

连接状态卡、运行会话数、文字／图片能力说明；配对表单折叠，密码显示／隐藏，连接中禁用重复提交；明确错误提示；断开前二次确认，提醒网页任务不会被停止。加入主动打开 ChatGPT 的按钮（不会发送消息）。支持系统深色／浅色、键盘焦点和减少动画设置。

### Paseo 插件

跟随宿主主题的分区卡片，手机窄屏布局；连接与目录同步独立显示；按需显示配对码、剩余有效时间及复制按钮；模型和思考强度分组；应用搜索和选中数量；默认设置摘要、未保存提示、撤销未保存修改；后台轮询不会覆盖用户修改。修正保存回执与旧轮询竞态，不用客户端时钟比较服务器时间。历史异常折叠，不占据主要设置流程，保留人工确认和不自动删除的边界。

新图片卡片支持加载、失败、重试读取、放大预览和网页原图入口。重试只读取已保存的图片，不重新生图；没有可用预览字节时直接显示网页入口，不空转。

## 3. 验证与证据

`docs/evidence-alpha3-8/` 保存执行日志与界面截图。

- 全量 Node 测试：151 项通过，包括新增 10 项媒体身份、容量、路径、哈希、跨会话隔离和图片完成检查。
- 真实 Chrome MV3 + Runtime + 已安装 Paseo 0.11.2 SDK：图片 URL、blob、缺失像素三套场景分别 6 项；包括图片独立完成、后续文字、页面刷新恢复与无重复发送。
- CoS 图片归属浏览器对抗检查：7 项；预览状态、未完成兄弟图片、错误原生 messageIds、隐藏页、外部 URL、错误 blob 控件身份均不会被误当成有效图片。
- 现有回执、文本、目录与双会话浏览器测试，以及原文／转义 MV3 流程重新通过。最终汇总数字见 `summary.json`。
- 实际 TSX 组件使用 React/RN-web 渲染，13 项界面检查通过；覆盖 390 像素手机深色、桌面浅色、未保存状态、搜索、保存失败、两分钟服务器时钟偏差、配对码复制、图片放大、重试和两套 Chrome 弹窗。截图已逐项查看。测试中的宿主 RPC 与 Modal 外壳是夹具，不等于真实 Paseo iOS 原生外壳验收。
- 完整 TypeScript 检查通过：使用真实固定版本 SDK 与 React Native 声明；没有用自造 SDK 类型替代。为不改变生产插件依赖，将测试依赖隔离安装在 `.test-tools/ui/`。
- 来源完整性、JavaScript/JSON、实际安装 SDK 契约检查均执行。没有测到的登录账号图片回传，不宣称已通过。

常用复跑命令：

```sh
export PATH=/opt/homebrew/bin:$PATH
node --test tests/*.test.mjs
node scripts/verify-upstream.mjs
node .test-tools/ui/typecheck.cjs
node .test-tools/ui/build.cjs
export CIP_CHROMIUM='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
.test-tools/bin/python tests/images-ui-browser.py
.test-tools/bin/python tests/images-public-browser.py
export CIP_NODE='/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper'
export CIP_SDK_MODULE='file:///Applications/Paseo.app/Contents/Resources/app.asar/node_modules/@getpaseo/plugin/dist/server/provider.js'
export ELECTRON_RUN_AS_NODE=1
# 三个用例分别运行；missing 含有界等待，不要塞入一个短超时命令。
CIP_IMAGE_FIXTURE=url .test-tools/bin/python tests/images-mv3-flow.py
CIP_IMAGE_FIXTURE=blob .test-tools/bin/python tests/images-mv3-flow.py
CIP_IMAGE_FIXTURE=missing .test-tools/bin/python tests/images-mv3-flow.py
```

一次合并执行三套图片测试超过外层 120 秒请求限制。之后核对三份独立日志均完整 PASS，缺失像素测试进程已自行完成退出；没有把空日志或未结束进程计为通过。

## 4. 生效与用户验收

先确认旧网页生成已结束，关闭 Paseo 中旧的卡住会话，再一起重载 Paseo 插件和 Chrome 扩展。Chrome 应显示 alpha.3.8（内部版本 0.1.10）。刷新空闲 ChatGPT 页面。不需要重新配对或删除状态。

新测试会话先验证普通文字，再发送一条新的图片请求。验收：Paseo 出现图片卡片、点击可放大、网页入口打开正确对话、网页完成后 Paseo 结束该轮，后续文字沿用原会话。旧版已经失败／阻断的轮次不会被后台自动重跑或改成成功；旧图片继续留在原网页。

本版不调整此前讨论的文字增量推送策略，避免同时改变已经验收的流式通道。
