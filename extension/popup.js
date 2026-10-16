const $ = selector => document.querySelector(selector);
const views = ['dashboard', 'pair-section', 'disconnect-confirm'];
let busy = false, paired = false, polling = false;
let currentView = 'dashboard', returnView = 'dashboard';

const messages = {
  AUTH_REQUIRED: '配对信息已失效，请在 Paseo 生成新的配对码。',
  PAIRING_REJECTED: '配对码无效或已过期。现有连接未被替换。',
  BRIDGE_BUSY: '仍有会话在运行，请等待结束后再更换配对。',
  INVALID_ENDPOINT: '请输入当前电脑的 127.0.0.1 本地地址。',
  PROTOCOL_MISMATCH: '两个插件版本不兼容，请一起更新并重载。'
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
      name === 'pair-section' ? $('#pair-title') : $('#disconnect-title');
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
$('#show-pair').addEventListener('click', () => {
  if (busy) return;
  notice('');
  setView('pair-section');
});
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
