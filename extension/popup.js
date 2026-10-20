const $ = selector => document.querySelector(selector);
const views = ['dashboard', 'pair-section', 'disconnect-confirm', 'recovery-section'];
let busy = false, paired = false, polling = false;
let currentView = 'dashboard', returnView = 'dashboard';

const messages = {
  AUTH_REQUIRED: '配对信息已失效，请在 Paseo 生成新的配对码。',
  PAIRING_REJECTED: '配对码无效或已过期。现有连接未被替换。',
  BRIDGE_BUSY: '仍有会话在运行，请等待结束后再更换配对。',
  INVALID_ENDPOINT: '请输入当前电脑的 127.0.0.1 本地地址。',
  PROTOCOL_MISMATCH: '两个插件版本不兼容，请一起更新并重载。',
  OPEN_CHATGPT_TAB: '请先打开目标 ChatGPT 对话，再点“接回网页回答”。',
  RECOVERY_SESSION_NOT_FOUND: '当前页面对话没有匹配的未确认 Paseo 会话。',
  RECOVERY_MESSAGE_UNSUPPORTED: '这条用户消息缺少稳定的网页消息 ID，不能作为接回目标。',
  RECOVERY_BOUNDARY_UNKNOWN: '无法确认这条消息的回答边界。请打开包含完整回答的对话，并滚动到这一轮之后再试。',
  RECOVERY_ALREADY_ACTIVE: '这个会话已有正在进行的接回。',
  RECOVERY_NOT_AVAILABLE: '这个会话当前没有可接回的未确认结果。',
  RECOVERY_BUSY: '这个会话仍在发送或接收消息，暂时不能接回。',
  RECOVERY_NOT_ACTIVE: '这次接回已经结束或不存在。',
  WRONG_CONVERSATION: '当前网页与目标会话不一致，请打开对应的 ChatGPT 对话。'
};

function notice(text, error = false) {
  const el = $('#status');
  el.hidden = !text;
  el.textContent = text;
  el.dataset.error = String(error);
}

function resetSecret() {
  $('#code').value = '';
  $('#code').type = 'password';
  $('#reveal').textContent = '显示';
  $('#reveal').setAttribute('aria-label', '显示配对码');
}

function setView(name, focus = true) {
  if (!views.includes(name)) return;
  if (currentView === 'pair-section' && name !== 'pair-section') resetSecret();
  currentView = name;
  for (const id of views) $('#' + id).hidden = id !== name;
  $('#disconnect').hidden = !paired || name === 'disconnect-confirm';
  if (focus) {
    const heading = name === 'dashboard' ? $('#connection-title') :
      name === 'pair-section' ? $('#pair-title') :
      name === 'recovery-section' ? $('#recovery-title') : $('#disconnect-title');
    heading.focus({ preventScroll: true });
  }
}

function setBusy(value) {
  busy = value;
  for (const el of document.querySelectorAll('button, #pair input')) el.disabled = value;
  $('#disconnect').disabled = value || !paired;
  $('#connect-label').textContent = value ? '正在连接…' : '连接 Paseo';
}

function updateActions() {
  const settings = $('#show-pair');
  const openChat = $('#open-chat');
  settings.classList.toggle('primary', !paired);
  settings.classList.toggle('first-action', !paired);
  openChat.classList.toggle('primary', paired);
  settings.textContent = paired ? '配对设置' : '开始配对';
  $('#disconnect').hidden = !paired || currentView === 'disconnect-confirm';
  $('#disconnect').disabled = busy || !paired;
  $('#show-recovery').hidden = !paired;
  $('#show-recovery').disabled = busy || !paired;
}

async function call(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error ?? 'BRIDGE_UNAVAILABLE');
  return reply.value;
}

function displayEndpoint(value) {
  try {
    const url = new URL(value);
    return url.host || value;
  } catch { return value || '127.0.0.1:17843'; }
}

function renderConnection(state) {
  paired = !!state.paired;
  const mode = state.connected ? 'online' : paired ? 'waiting' : 'offline';
  $('#connection').dataset.state = mode;
  $('#state-label').textContent = mode === 'online' ? '本机连接正常' :
    mode === 'waiting' ? '等待 Paseo' : '尚未配对';
  $('#connection-title').textContent = mode === 'online' ? '已连接 Paseo' :
    mode === 'waiting' ? 'Paseo 暂未响应' : '连接 ChatGPT 与 Paseo';
  $('#connection-description').textContent = mode === 'online'
    ? '已准备好接收来自 Paseo 的消息，并将对话结果同步回来。'
    : mode === 'waiting'
      ? '已保存配对信息。检查 Paseo App 和 Chatmode 插件是否正在运行。'
      : '只需一次配对，就能从 Paseo 使用已有的 ChatGPT 对话。';

  $('#activity').hidden = !state.connected;
  $('#activity').textContent = (state.activeSessions ?? 0) > 0
    ? `${state.activeSessions} 个活跃会话` : '当前待命';
  $('#address').textContent = displayEndpoint(state.endpoint);
  if (!$('#endpoint').dataset.edited && document.activeElement !== $('#endpoint')) {
    $('#endpoint').value = state.endpoint;
  }
  updateActions();
}

async function refresh() {
  if (polling || busy) return;
  polling = true;
  try {
    const state = await call({ type: 'status' });
    renderConnection(state);
  } catch {
    // An unavailable Runtime is not proof that the pairing was deleted.
    $('#connection').dataset.state = 'unknown';
    $('#state-label').textContent = '连接状态未知';
    $('#connection-title').textContent = '暂时无法读取状态';
    $('#connection-description').textContent = '请稍后再试。结果不明的消息不会被自动重发。';
    $('#activity').hidden = true;
  } finally { polling = false; }
}

const manifest = chrome.runtime.getManifest();
$('#version').textContent = 'v' + (manifest.version || manifest.version_name?.replace('0.1.0-', '') || '—');
$('#version').title = 'Chrome 扩展 ' + (manifest.version ?? manifest.version_name ?? '');

$('#endpoint').addEventListener('input', () => { $('#endpoint').dataset.edited = 'true'; });
function dom(tag, text = null, className = '') {
  const node = document.createElement(tag);
  if (text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function shortId(value) {
  return typeof value === 'string' && value.length > 14 ? value.slice(0, 8) + '…' : value;
}
function recoveryError(error) {
  return messages[error?.message] ?? '暂时无法读取接回目标。请稍后重试。';
}
function renderActiveRecovery(body, row) {
  const block = dom('div', null, 'recovery-block');
  block.append(dom('h3', '正在接回网页回答'));
  const review = row.recovery?.status === 'needs_review';
  block.append(dom('p', review
    ? '页面中的目标轮边界已经变化。旧内容没有导入；请取消后重新选择。'
    : '只读取你选定的目标轮，正在等待目标回答稳定并经过宿主确认。不会自动重发原消息。'));
  block.append(dom('p', `会话 ${shortId(row.sessionId)}`));
  const cancel = dom('button', '取消这次接回');
  cancel.type = 'button';
  cancel.className = 'danger';
  cancel.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    try {
      await call({ type: 'recovery-cancel', sessionId: row.sessionId });
      notice('已取消接回，不会自动重发原消息。');
      setView('dashboard');
      void refresh();
    } catch (error) {
      notice(recoveryError(error), true);
    } finally { setBusy(false); }
  });
  const actions = dom('div', null, 'recovery-actions');
  actions.append(cancel);
  block.append(actions);
  body.append(block);
}
function renderRecovery(info) {
  const body = $('#recovery-body');
  body.replaceChildren();
  const sessions = Array.isArray(info.sessions) ? info.sessions : [];
  const active = sessions.find(row => ['observing', 'needs_review'].includes(row.recovery?.status));
  if (active) {
    renderActiveRecovery(body, active);
    return;
  }
  if (!sessions.length) {
    body.append(dom('p', '当前 ChatGPT 对话没有匹配的未确认 Paseo 会话。请先在 Paseo 打开那个结果未确认的会话，再回到对应网页。', 'recovery-note'));
    return;
  }
  if (!Array.isArray(info.candidates) || !info.candidates.length) {
    body.append(dom('p', '当前页面没有读到可选择的用户消息。请打开包含目标问题的对话，并等待页面加载完成。', 'recovery-note'));
    return;
  }
  let selectedSession = sessions[0].sessionId;
  const block = dom('div', null, 'recovery-block');
  block.append(dom('h3', '选择目标 Paseo 会话'));
  if (sessions.length > 1) {
    const select = dom('select');
    select.setAttribute('aria-label', '目标 Paseo 会话');
    for (const row of sessions) {
      const option = dom('option', shortId(row.sessionId));
      option.value = row.sessionId;
      select.append(option);
    }
    select.addEventListener('change', () => { selectedSession = select.value; });
    block.append(select);
    block.append(dom('p', '同一对话有多个未确认会话，请选择要接回的那个。'));
  } else {
    block.append(dom('p', `会话 ${shortId(selectedSession)}`));
  }
  body.append(block);

  const choices = dom('div', null, 'recovery-block');
  choices.append(dom('h3', '选择目标用户消息'));
  let selectedMessage = null;
  const claim = dom('button', '接回这一轮');
  claim.type = 'button';
  claim.className = 'primary';
  claim.disabled = true;
  const buttons = [];
  for (const candidate of info.candidates) {
    const supported = candidate.recoverable === true;
    const bounded = candidate.boundaryKnown === true;
    const text = typeof candidate.text === 'string' && candidate.text.trim()
      ? candidate.text.trim().slice(0, 240) : '（这条用户消息没有可读取文字）';
    const button = dom('button', text, 'recovery-candidate');
    button.type = 'button';
    button.disabled = !supported || !bounded;
    if (supported && bounded) {
      button.addEventListener('click', () => {
        selectedMessage = candidate.userMessageId;
        for (const item of buttons) item.dataset.selected = String(item === button);
        claim.disabled = false;
      });
    } else if (!supported) {
      button.append(dom('small', '缺少稳定消息 ID，不能接回'));
    } else {
      button.append(dom('small', '无法确认页面末尾，请滚动到这一轮之后再试'));
    }
    buttons.push(button);
    choices.append(button);
  }
  const actions = dom('div', null, 'recovery-actions');
  actions.append(claim);
  choices.append(actions);
  body.append(choices);

  claim.addEventListener('click', async () => {
    if (busy || !selectedMessage || !selectedSession) return;
    setBusy(true);
    try {
      await call({ type: 'recovery-claim', sessionId: selectedSession, userMessageId: selectedMessage });
      notice('已开始接回这一轮网页回答；不会自动重发原消息。');
      setView('dashboard');
      void refresh();
    } catch (error) {
      notice(recoveryError(error), true);
    } finally { setBusy(false); }
  });
}
async function loadRecovery() {
  if (busy) return;
  const body = $('#recovery-body');
  body.replaceChildren(dom('p', '正在读取当前 ChatGPT 对话…', 'recovery-note'));
  setBusy(true);
  let info = null, error = null;
  try { info = await call({ type: 'recovery-inspect' }); }
  catch (value) { error = value; }
  setBusy(false);
  if (currentView !== 'recovery-section') return;
  if (error) {
    body.replaceChildren(dom('p', recoveryError(error), 'recovery-note'));
    return;
  }
  renderRecovery(info);
}

$('#show-pair').addEventListener('click', () => {
  if (busy) return;
  notice('');
  setView('pair-section');
});
$('#show-recovery').addEventListener('click', () => {
  if (busy || !paired) return;
  notice('');
  setView('recovery-section');
  void loadRecovery();
});
$('#back-from-recovery').addEventListener('click', () => { notice(''); setView('dashboard'); });
$('#back-home').addEventListener('click', () => { notice(''); setView('dashboard'); });
$('#reveal').addEventListener('click', () => {
  const visible = $('#code').type === 'password';
  $('#code').type = visible ? 'text' : 'password';
  $('#reveal').textContent = visible ? '隐藏' : '显示';
  $('#reveal').setAttribute('aria-label', visible ? '隐藏配对码' : '显示配对码');
});

$('#pair').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  notice('');
  try {
    await call({ type: 'pair', endpoint: $('#endpoint').value.trim(), code: $('#code').value.trim() });
    paired = true;
    setView('dashboard');
    updateActions();
    notice('配对成功。现在可在 Paseo 新建 Chatmode 会话。');
  } catch (error) {
    notice(messages[error.message] ?? '暂时无法连接。请确认 Paseo 正在运行并检查本机地址。', true);
  } finally {
    setBusy(false);
    void refresh();
  }
});

$('#disconnect').addEventListener('click', () => {
  if (busy || !paired) return;
  returnView = currentView;
  notice('');
  setView('disconnect-confirm');
});
function cancelDisconnect() {
  notice('');
  setView(returnView);
}
$('#cancel-disconnect').addEventListener('click', cancelDisconnect);
$('#back-from-disconnect').addEventListener('click', cancelDisconnect);
$('#confirm-disconnect').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try {
    await call({ type: 'disconnect' });
    paired = false;
    setView('dashboard');
    updateActions();
    notice('桥接已断开。已发出的网页任务没有被停止。');
  } catch { notice('未能断开，请稍后重试。', true); }
  finally { setBusy(false); void refresh(); }
});

$('#open-chat').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://chatgpt.com/' })
    .catch(() => notice('网页未能打开，请手动进入 ChatGPT。', true));
});

void refresh();
const timer = setInterval(() => void refresh(), 2000);
addEventListener('pagehide', () => clearInterval(timer), { once: true });
