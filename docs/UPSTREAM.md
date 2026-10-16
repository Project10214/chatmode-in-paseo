# 上游依据

读取日期：2026-10-13。使用以下固定源码进行接口对齐，不保证这些提交永远是最新版本。

## Paseo

- 固定提交：`b923cde6cfda7c04ce9886b41552a4159e33ba6f`
- SDK `@getpaseo/plugin`：`0.11.2`
- [Provider 协议源码](https://github.com/getpaseo/paseo/blob/b923cde6cfda7c04ce9886b41552a4159e33ba6f/packages/plugin/src/server/provider.ts)
- [官方直接 Provider 示例](https://github.com/getpaseo/paseo/blob/b923cde6cfda7c04ce9886b41552a4159e33ba6f/plugin-examples/provider-direct/server/provider.ts)
- [SDK 包定义](https://github.com/getpaseo/paseo/blob/b923cde6cfda7c04ce9886b41552a4159e33ba6f/packages/plugin/package.json)
- [Provider 官方文档](https://paseo.sh/docs/plugins/providers)
- [插件官方参考](https://paseo.sh/docs/plugins/reference)

代码遵循 v1 事件契约；没有把模拟 example 的固定假模型当作真实目录。离线测试使用明确标注的模拟输入；`tests/sdk-contract.mjs` 另有实际 SDK 的 Input/EventSchema 检查，须安装依赖后运行。本次未成功加载 SDK，不用自建类型替身声称兼容。alpha.2 设置入口依照官方 `addSettingsScreen`/`PluginSurfaceProps` 契约修订，宿主实机仍待验。

## Chat On Steroids

- 固定提交：`ccd23b66cecf2f684fa3e12ca190297be02842cf`
- 参考版本：`2.1.35`
- [DOM 适配源](https://github.com/totec448-spec/chat-on-steroids/blob/ccd23b66cecf2f684fa3e12ca190297be02842cf/extension/chatgpt-dom.js)，alpha.3 直接移植控件、原生 Send 回执和模型选择函数；详细范围见 [直接移植清单](../vendor/cos/README.md)。
- [系统职责与生命周期说明](https://github.com/totec448-spec/chat-on-steroids/blob/ccd23b66cecf2f684fa3e12ca190297be02842cf/AGENTS.md)
- [发送持久队列](https://github.com/totec448-spec/chat-on-steroids/blob/ccd23b66cecf2f684fa3e12ca190297be02842cf/src/main/session/input.ts)
- [扩展 worker](https://github.com/totec448-spec/chat-on-steroids/blob/ccd23b66cecf2f684fa3e12ca190297be02842cf/extension/background.js)
- [MIT 许可证](https://github.com/totec448-spec/chat-on-steroids/blob/ccd23b66cecf2f684fa3e12ca190297be02842cf/LICENSE)

保留“队列不等于送达、未知副作用不重放、严格会话身份、原生设置回读”的原则。未整体移植原版桌面应用、插件管理器、MCP 工具执行、多 agent broker、自动续跑及完整 Fiber 扫描。新协议和扩展必须作为一对安装。


## alpha.3 的直接复制与改造

活跃移植模块、原函数名、边界改动和本地哈希见 `vendor/cos/provenance.json`。此次新增 Fiber 模型读取与公开正文/终局子集；不再把“参考架构”称为“核心已经移植”。运行服务和 Paseo 协议转换仍是本项目适配实现。
