const $ = id => document.getElementById(id);
const editor = $('editor');
const credentialKey = 'sf-room-credential';
const recoveryKey = 'sf-room-recovery';
const reasons = {
  locked: '另一位成员正在编辑这条字幕。',
  expired: '编辑锁已过期，输入已保留，可以重试。',
  conflict: '这条字幕已有更新。请对照当前内容后重新编辑。',
  invalid_edit: '请检查文字和时间。ASS 换行请使用 \\N。',
  unstable_mapping: '这次修改会改变其他条目的分组，已保留原稿。',
  save_failed: '主机无法写入，或原稿已在房间外发生变化。',
  full: '房间已满。',
  unauthorized: '邀请无效或房间已结束。',
  ended: '房间已结束。'
};
let token = '', snapshot, rowId = '', baseRow, lease = null, draft = null, pending = null;
let connected = false, ended = false, busy = false, composing = false;
let storageAvailable = true;

function stored(key) {
  try { return sessionStorage.getItem(key); }
  catch { storageAvailable = false; return null; }
}
function cache(key, value) {
  try {
    if (value == null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch { storageAvailable = false; }
}
const currentRow = () => snapshot?.entries.find(row => row.id === rowId);
const hasDraft = () => !!(draft || pending);
const note = text => { $('message').textContent = text; };
const textOf = row => row.text ?? [row.zh, row.en].filter(value => value != null).join('\n');

function saveRecovery() {
  const content = hasDraft() ? { sessionId: snapshot.sessionId, rowId, baseRow, draft, pending: pending?.requestId } : null;
  cache(recoveryKey, content ? JSON.stringify(content) : null);
  $('download').hidden = !content;
  if (content && !storageAvailable) note('浏览器无法保存恢复记录，请下载待恢复修改。');
}

async function api(path, data, auth = token, signal = AbortSignal.timeout(8000)) {
  const headers = { Authorization: 'Bearer ' + auth };
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch('/api/' + path, { headers, method: data === undefined ? 'GET' : 'POST',
    body: data === undefined ? undefined : JSON.stringify(data), signal });
  if (!res.ok) {
    const result = await res.json();
    throw Object.assign(new Error(reasons[result.reason] || '房间暂时无法处理这个请求。'), result);
  }
  return res;
}

function updateButtons() {
  const row = currentRow();
  const conflict = draft && row && row.version !== baseRow.version;
  const blocked = !connected || ended || busy || !row;
  $('fields').disabled = blocked || !!pending;
  $('mode').disabled = hasDraft();
  $('side').disabled = hasDraft();
  $('word').disabled = hasDraft();
  $('edge').disabled = hasDraft();
  $('save').disabled = blocked || !hasDraft() || (!!conflict && !pending);
  $('discard').disabled = busy || !hasDraft();
  $('exit').disabled = !connected || ended || busy;
  $('comparison').hidden = !conflict;
  if (conflict) $('comparison').textContent = '编辑前\n' + textOf(baseRow) + '\n\n当前稿件\n' +
    textOf(row) + '\n' + row.start + '–' + row.end + ' 秒';
  for (const button of $('cues').querySelectorAll('button')) button.disabled = !!(busy || (hasDraft() && button.dataset.id !== rowId));
}

function listRows() {
  const q = $('filter').value.trim().toLowerCase();
  const rows = snapshot.entries.filter(row => !q || textOf(row).toLowerCase().includes(q));
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.id = row.id;
    if (row.id === rowId) button.setAttribute('aria-current', 'true');
    const time = document.createElement('small');
    time.textContent = row.start.toFixed(2) + ' – ' + row.end.toFixed(2) + ' 秒';
    const text = document.createElement('span');
    text.textContent = textOf(row);
    button.append(time, text);
    li.append(button);
    fragment.append(li);
  }
  $('cues').replaceChildren(fragment);
}

function renderFields(op = $('mode').value) {
  const row = currentRow();
  editor.hidden = !row;
  $('selection').hidden = !!row;
  if (!row) return;
  const isAss = snapshot.format === 'ass';
  const words = row.words || [];
  const values = draft && draft.op === op ? draft : null;
  $('mode').querySelector('[value=word]').disabled = !words.length;
  if (op === 'word' && !words.length) op = 'text';
  $('mode').value = op;
  for (const name of ['text', 'time', 'word']) $(name + '-fields').hidden = op !== name;
  $('side-label').hidden = !isAss;
  for (const option of $('side').options) option.disabled = row[option.value] == null;
  if (values?.side) $('side').value = values.side;
  if (isAss && row[$('side').value] == null) $('side').value = row.zh != null ? 'zh' : 'en';
  $('body').value = values?.text ?? (isAss ? row[$('side').value] : row.text);
  $('start').value = values?.start ?? row.start;
  $('end').value = values?.end ?? row.end;
  const index = values?.index ?? (Number($('word').value) || 0);
  $('word').replaceChildren(...words.map((word, i) => {
    const option = document.createElement('option');
    option.value = i;
    option.textContent = word.text;
    return option;
  }));
  if (words[index]) $('word').value = index;
  if (values?.edge) $('edge').value = values.edge;
  const edge = $('edge').value === 'word-start' ? 'start' : 'end';
  $('word-time').value = values?.time ?? words[$('word').value]?.[edge] ?? '';
}

function render() {
  $('connection').textContent = ended ? '房间已结束' : connected
    ? (snapshot.owner ? '主机' : '成员') + ' · 已保存版本 ' + snapshot.revision : '连接中断，正在重连…';
  $('exit').hidden = !snapshot;
  if (snapshot) $('exit').textContent = snapshot.owner ? '结束协作' : '离开房间';
  updateButtons();
}

async function refresh() {
  const next = await (await api('snapshot')).json();
  if (snapshot && (next.sessionId !== snapshot.sessionId || next.revision < snapshot.revision)) return;
  const changed = !snapshot || next.revision !== snapshot.revision;
  snapshot = next;
  if (!changed) return;
  listRows();
  if (!hasDraft()) {
    baseRow = currentRow();
    renderFields();
  }
  render();
}

async function connect() {
  while (!ended) {
    const controller = new AbortController();
    let deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await api('events', undefined, token, controller.signal);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          clearTimeout(deadline);
          deadline = setTimeout(() => controller.abort(), 30_000);
          buffered += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffered.indexOf('\n\n')) >= 0) {
            const event = JSON.parse(buffered.slice(6, end));
            buffered = buffered.slice(end + 2);
            if (event.closed) { ended = true; break; }
            if (!snapshot || !connected || event.revision > snapshot.revision) await refresh();
            connected = true;
            render();
          }
          if (ended) break;
        }
      } finally { await reader.cancel().catch(() => {}); }
    } catch (err) {
      if (['unauthorized', 'ended'].includes(err.reason)) ended = true;
    }
    clearTimeout(deadline);
    connected = false;
    render();
    if (!ended) await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

function capture() {
  if (busy || pending || !baseRow) return;
  const op = $('mode').value;
  if (op === 'text') {
    draft = { op, text: $('body').value };
    if (snapshot.format === 'ass') draft.side = $('side').value;
  } else if (op === 'time') draft = { op, start: $('start').value, end: $('end').value };
  else draft = { op, index: Number($('word').value), edge: $('edge').value, time: $('word-time').value };
  saveRecovery();
  render();
}

async function getLease() {
  if (lease && lease.until > Date.now() + 2000) return lease;
  const result = await (await api('lock', { entryId: rowId })).json();
  lease = { ...result, entryId: rowId };
  return lease;
}

async function release() {
  if (!lease) return;
  const { entryId, token: lockToken } = lease;
  lease = null;
  await api('release', { entryId, token: lockToken }).catch(() => {});
}

$('filter').addEventListener('input', () => { if (snapshot) listRows(); render(); });
$('cues').addEventListener('click', async event => {
  const button = event.target.closest('button[data-id]');
  if (!button || busy || !connected || (hasDraft() && button.dataset.id !== rowId)) return;
  if (rowId === button.dataset.id && hasDraft()) return;
  busy = true;
  render();
  try {
    if (rowId !== button.dataset.id) await release();
    rowId = button.dataset.id;
    baseRow = currentRow();
    renderFields('text');
    listRows();
    await getLease();
    note('');
  } catch (err) { note(err.message); }
  finally { busy = false; render(); }
});
for (const id of ['mode', 'side', 'word', 'edge']) $(id).addEventListener('change', () => renderFields());
for (const id of ['body', 'start', 'end', 'word-time']) $(id).addEventListener('input', capture);
$('body').addEventListener('compositionstart', () => { composing = true; });
$('body').addEventListener('compositionend', () => { composing = false; capture(); });

editor.addEventListener('submit', async event => {
  event.preventDefault();
  if (!connected || busy || composing || !draft || (!pending && currentRow()?.version !== baseRow.version)) return;
  busy = true;
  render();
  try {
    if (!pending) {
      const command = { ...draft };
      for (const field of ['start', 'end', 'time']) {
        if (field in command) {
          if (command[field] === '') return note('请填写时间。');
          command[field] = Number(command[field]);
        }
      }
      const lock = await getLease();
      pending = { ...command, sessionId: snapshot.sessionId, entryId: rowId, version: baseRow.version,
        requestId: crypto.randomUUID(), token: lock.token };
      saveRecovery();
    }
    const res = await api('intent', pending);
    await res.json();
    pending = null;
    draft = null;
    saveRecovery();
    await refresh();
    baseRow = currentRow();
    renderFields();
    note('修改已保存。');
  } catch (err) {
    if (err.reason && err.reason !== 'internal') {
      pending = null;
      if (err.reason === 'expired') lease = null;
      if (err.reason === 'conflict') await refresh().catch(() => {});
    }
    saveRecovery();
    note(!err.reason || err.reason === 'internal' ? '未收到保存回执。重试会核对同一次提交。' : err.message);
  } finally { busy = false; render(); }
});

$('discard').addEventListener('click', async () => {
  if (pending && !confirm('这次提交可能已写入主机。要清除本地恢复记录吗？')) return;
  pending = null;
  draft = null;
  saveRecovery();
  await refresh().catch(() => {});
  baseRow = currentRow();
  renderFields();
  note('');
  render();
});

$('download').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ sessionId: snapshot.sessionId, rowId, baseRow, draft,
    requestId: pending?.requestId }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'SubFabric-协作恢复.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('exit').addEventListener('click', async () => {
  if (hasDraft() && !confirm('还有待恢复修改。要保留恢复记录并离开吗？')) return;
  try {
    await api(snapshot.owner ? 'end' : 'leave', {});
    ended = true;
    connected = false;
    cache(credentialKey, null);
    render();
  } catch (err) { note(err.message); }
});

setInterval(async () => {
  if (!connected || ended || busy || !lease) return;
  const prior = lease;
  try {
    const result = await (await api('lock', { entryId: prior.entryId, token: prior.token })).json();
    if (lease === prior) lease = { ...result, entryId: prior.entryId };
  } catch {
    if (lease === prior) lease = null;
  }
}, 5000);
window.addEventListener('beforeunload', event => {
  if (hasDraft()) { event.preventDefault(); event.returnValue = ''; }
});

try {
  const params = new URLSearchParams(location.hash.slice(1));
  const invite = params.get('invite'), host = params.get('host');
  if (location.hash) history.replaceState(null, '', location.pathname);
  token = host || (invite ? (await (await api('join', {}, invite)).json()).token : stored(credentialKey));
  if (!token) throw new Error('请从 SubFabric 复制本机协作邀请链接。');
  cache(credentialKey, token);
  await refresh();
  let saved = null;
  try { saved = JSON.parse(stored(recoveryKey)); } catch {}
  if (saved?.sessionId === snapshot.sessionId && saved.draft && snapshot.entries.some(row => row.id === saved.rowId)) {
    let outcome;
    if (saved.pending) {
      try { outcome = await (await api('receipt', { requestId: saved.pending })).json(); }
      catch { /* 认证或网络出错时仍保留输入。 */ }
    }
    if (outcome?.result?.ok) {
      cache(recoveryKey, null);
      note('已核对此前的提交，它已在主机保存。');
    } else {
      ({ rowId, baseRow, draft } = saved);
      listRows();
      renderFields(draft.op);
      $('download').hidden = false;
      note(saved.pending && !outcome ? '已恢复输入。此前提交可能已保存，请先与当前稿件核对。' : '已恢复待提交输入。');
    }
  }
  void connect();
} catch (err) {
  ended = true;
  $('connection').textContent = '无法连接房间';
  note(err.message);
}
