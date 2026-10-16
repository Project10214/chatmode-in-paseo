# CIP Chrome 0.2.13 · 修复 ATTACHMENT_INPUT_AMBIGUOUS（2026-10-16）

## 结论
Chrome 扩展 **0.2.13 候选源码**修复了附件选择时过度宽泛的输入框匹配；Paseo 插件 **0.1.0-alpha.4.7**、Runtime、CIP v5、原生引擎名称均不需要改动。本次**没有重载生产 Chrome、Paseo 或其他 Agent**。真实已登录 ChatGPT 的上传及消息发送仍需空闲窗口验收，COSINPASEO-7 保持 In Progress。

## 真实报错证据
对本机现有 `~/.cos-in-paseo/state.json` 作只读核查：2026-10-16 有一条上传 **1 张 PNG** 的 Send 命令以 `ATTACHMENT_INPUT_AMBIGUOUS` 失败；该命令标为 failed，没有原生点击记录。没有读取/记录用户正文或图片字节，也没有重发原消息。

旧实现 `extension/file-upload.js`：
- 当前表单找不到输入框时，把网页上的全部 `input[type=file]` 都当作候选，连不属于当前 ChatGPT Composer 的控件也可能被纳入。
- 匹配只判断 `accept` 是否兼容；同时存在通用上传与图片专用上传时，两个控件均匹配 PNG，直接报 `ATTACHMENT_INPUT_AMBIGUOUS`。
- 混合图片+文档只能找单个同时接受全部类型的 input，无法支持 ChatGPT 分开的图片/文档输入框。
- 新版 ChatGPT 中文加号按钮 `data-composer-navigation-target="add-context"` 没有被识别，表单外 portal input 更难绑定到正确 Composer。

## 已修复
1. **先限定归属**：优先读取当前输入框所在 form 的 file input，不再在开始时对全页面无差别匹配。对 portal input，必须先从当前 Composer 的原生“添加文件”等按钮进入上传流程，才允许匹配；其他 form（如头像）被排除。
2. **按类型匹配**：精确 MIME、扩展名、媒体类通配（如 `image/*`）依次优先，`accept` 为空的通用 input 最后考虑。不按 DOM 顺序猜测，同等级仍多个候选则继续安全拒绝。
3. **支持拆分输入框**：图片和文档可分别交给不同原生 input，每次先组装全部用户已提供文件并校验 SHA-256，再对各自 input 触发原生 change，等全部附件展示和上传确认后才允许一次性 Send。
4. **支持中文新版入口**：识别 `data-composer-navigation-target="add-context"` 和 “添加文件…” 控件；只在用户所属 Composer 的明确入口之后寻找 portal input，不点击无关控件。
5. **保留安全边界**：输入框无法唯一确定、附件未确认、被用户改动、会话切换时仍拒绝；不自动重发失败历史消息。

## 本机执行和测试结果
- 完整 Node 套件：**337/337 PASS**。
- 新增隔离真实 Chrome 多输入框专项 **4/4 PASS**：① PNG 专用入口优先于通用入口；② PNG+PDF 分别进入独立输入框；③ 两个等价模糊控件必须拒绝且不上传；④ 中文原生加号后创建 portal input，拒绝无关头像入口。
- 原有隔离 Chrome 文件上传 **4/4 PASS**（真实 File/DataTransfer、PNG+PDF 字节与附件展示）。
- 项目静态检查：**491 JS PASS**、CoS 来源哈希 **12/12 PASS**、TypeScript **23 文件零报错**。
- **以上 Chrome 均是隔离测试页，不是已登录真实 ChatGPT 发送成功。**

## 发布边界和下一步
- 仅需要更新 **Chrome 扩展到 0.2.13**，既有 Paseo `alpha.4.7` 无需再次升级、无需重新配对。
- 由于扩展升级会自动刷新它管理的已绑定 ChatGPT 标签，**先等其他 Agent 和网页任务彻底空闲**再重载解压扩展；不强制重启共享 Paseo。
- 先用专用空闲 Agent 发送一张 PNG，确认 ChatGPT 原生附件上传成功、只点击一次 Send、出现准确的原生用户消息与回答；再测 PDF、混合附件。
- 本次原 PNG 发送失败在原生点击之前，不应悄悄自动重试；更新后如需重试须是新的用户消息/ID。

受影响代码：`extension/file-upload.js`、`extension/manifest.json`、`tests/update-recovery.test.mjs`、新增 `tests/upload-input-choice-browser.py`。