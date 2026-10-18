/** Presentation only. Keep page state, local tracking and delivery evidence distinct. */
const phases = Object.freeze({
  working: '正在处理', thinking: '正在思考', tool: '正在调用工具',
  search: '正在搜索', exec: '正在执行代码', image: '正在生成图片',
  approval: '等待授权', finalizing: '正在确认回答', completed: '本轮已结束',
  canceled: '本轮已取消', failed: '本轮跟踪中断', observing: '网页状态待确认'
});
export const phaseLabel = phase => Object.hasOwn(phases, phase) ? phases[phase] : '网页状态未知';
export const approvalHint = '请在授权卡片中选择；卡片不可用时，请到 ChatGPT 网页处理。';

// Error codes stay on the wire for diagnostics. Never display arbitrary exception text.
const errors = Object.freeze({
  BRIDGE_FAILURE: '操作未完成，请检查插件状态。',
  PROVIDER_EVENT_INVALID: '插件输出与当前 Paseo 接口不符，结果未确认。',
  PROTOCOL_UNSUPPORTED: '当前 Paseo 通信协议不受支持，请更新插件。',
  BROWSER_UNAVAILABLE: '无法连接 Chrome，请检查浏览器和扩展。',
  EXTENSION_OFFLINE: 'Chrome 扩展未连接，请检查浏览器和扩展。',
  COMPOSER_READY_TIMEOUT: 'ChatGPT 输入框未就绪，请检查网页是否需要登录或验证。',
  PAGE_RELOAD_REQUIRED: '网页脚本需更新，请在本轮结束后刷新 ChatGPT 页面。',
  MODEL_OR_THINKING_UNAVAILABLE: '未能选中模型或思考强度，请检查 ChatGPT 页面。',
  MODEL_UNAVAILABLE: '所选模型不可用，请更新网页选项后重新选择。',
  THINKING_UNAVAILABLE: '所选思考强度不可用，请重新选择。',
  APP_UNAVAILABLE: '所选应用不可用，请更新网页选项后重新选择。',
  APP_SELECTION_CHANGED: '网页应用选择已变化，请核对工具设置。',
  CATALOG_REQUIRED: '请先连接扩展并更新模型与应用列表。',
  CONFIGURATION_BUSY: '正在应用配置，请稍后操作。',
  CONFIGURATION_PENDING: '配置尚未应用，请稍后操作。',
  CONFIG_NOT_CONFIRMED: '网页配置未确认，请检查 ChatGPT 页面。',
  CONTROL_UNCONFIRMED: '网页操作结果未确认，请检查原对话。',
  SESSION_BUSY: '此会话正在处理其他操作，请稍候。',
  SESSION_REQUIRES_INSPECTION: '会话状态需核对，请检查原 ChatGPT 对话。',
  SESSION_ALREADY_ATTACHED: '此会话已被其他连接占用。',
  SESSION_ATTACHED: '请先在 Paseo 关闭对应 Agent。',
  SESSION_UNKNOWN: '找不到此会话，请重新打开 Agent。',
  CONNECTION_CLOSED: '插件连接已断开，请检查插件状态。',
  RUNTIME_CLOSED: '插件已停止，请检查插件状态。',
  BRIDGE_TIMEOUT: '网页操作超时，结果未确认，请检查原对话。',
  DELIVERY_UNCONFIRMED: '消息送达未确认，不会自动重发。请先核对原对话。',
  RECEIPT_UNCONFIRMED: '消息送达未确认，不会自动重发。请先核对原对话。',
  STOP_UNCONFIRMED: '停止操作未确认，请检查网页；任务可能仍在运行。',
  BROWSER_BINDING_LOST: '与原网页的关联已断开，网页任务是否结束未确认。',
  TURN_CHANGED: '本轮已变化，请核对当前对话状态。',
  FINAL_SYNC_INCOMPLETE: '网页回答已结束，但内容尚未完整同步。请查看原对话。',
  SEND_CANCELLED: '发送流程已取消，请以送达状态为准。',
  CANCELLED_BEFORE_SEND: '发送已取消，消息未发出。',
  MESSAGE_ID_CONFLICT: '消息标识冲突，请新建一条消息。',
  QUEUE_FULL: '待处理请求已满，请稍后操作。',
  CONCURRENCY_LIMIT: '已达并发上限，请等待其他轮次结束。',
  PROMPT_HISTORY_LIMIT: '会话记录已达上限，请新建 Agent。',
  TURN_OUTPUT_LIMIT: '本轮内容超出同步上限，请查看原 ChatGPT 对话。',
  MCP_CONFIG_UNSUPPORTED: '不支持导入 Paseo MCP 配置，请使用 ChatGPT 已授权应用。',
  PROMPT_UNSUPPORTED: '不支持此消息形式，请使用普通消息。',
  ATTACHMENT_UNSUPPORTED: '不支持此附件，请检查文件类型。',
  ATTACHMENT_COUNT_UNSUPPORTED: '每条消息最多支持 4 个附件。',
  MODE_UNSUPPORTED: 'Chatmode 不支持此模式设置。',
  TOOL_POLICY_UNSUPPORTED: '请在 ChatGPT 网页管理工具权限。',
  APPROVAL_GONE: '原授权请求已变化或关闭，请核对网页。',
  APPROVAL_UNCONFIRMED: '未确认网页已处理授权，请核对网页。',
  APPROVAL_UNRECOGNIZED: '无法识别授权按钮，请到 ChatGPT 网页处理。',
  APPROVAL_BUSY: '授权操作正在处理，请稍候。',
  APPROVAL_UNSUPPORTED: '不支持此授权选项，请使用卡片中的选项。'
});
export function errorLabel(code) {
  if (Object.hasOwn(errors, code)) return errors[code];
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,159}$/.test(code)
    ? `操作未完成，请查看诊断（${code}）。` : '操作未完成，请查看诊断。';
}
