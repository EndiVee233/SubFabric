/* 全片术语表校对弹窗（编辑器「设置 → 高级字幕操作」入口）。
 *
 * 流程：
 *   1) POST /api/projects/:id/glossary-review —— 让「字幕翻译」那套模型通读全片中文字幕，
 *      找出中英文专有名词；术语表里已有的词由服务端带出现有译法。
 *   2) 在弹窗里逐条编辑（原文 / 译法都可改，可删）；模型新生成的词用高亮框提示
 *      （class `is-new`），已有词保持普通边框。
 *   3) POST /api/projects/:id/glossary-apply-project —— 把术语替换进当前稿件的中文轨
 *      （时间与英文轨不动），勾选「保存到翻译方案术语表」时同时合并写入方案。
 *      应用后用 projects.openProject() 重新载入稿件，界面立刻显示替换后的字幕。
 */
export function initGlossaryReview({ state, toast, projects }) {
  const $ = (id) => document.getElementById(id);
  const btn = $('btn-glossary-review');
  const els = {
    overlay: $('glossary-overlay'),
    msg: $('glossary-msg'),
    summary: $('glossary-summary'),
    list: $('glossary-list'),
    saveWrap: $('glossary-save-wrap'),
    save: $('glossary-save'),
    scheme: $('glossary-scheme'),
    cancel: $('glossary-cancel'),
    apply: $('glossary-apply'),
  };
  if (!btn || !els.overlay) return;

  let rows = [];      // { src, dst, known }
  let scheme = null;
  let busy = false;

  const show = (on) => { els.overlay.hidden = !on; };

  function syncApply() {
    const n = rows.filter(r => r.src.trim() && r.dst.trim()).length;
    els.apply.disabled = busy || !n;
    els.apply.textContent = n ? `应用到该视频（${n} 条）` : '应用到该视频';
  }

  function renderRows() {
    els.list.innerHTML = '';
    rows.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'glossary-row' + (r.known ? '' : ' is-new');
      const src = document.createElement('input');
      src.className = 'gl-src'; src.value = r.src; src.spellcheck = false;
      src.setAttribute('aria-label', '专有名词原文');
      const eq = document.createElement('span');
      eq.className = 'gl-eq'; eq.textContent = '=';
      const dst = document.createElement('input');
      dst.className = 'gl-dst'; dst.value = r.dst; dst.spellcheck = false;
      dst.setAttribute('aria-label', '术语表译法');
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'gl-del'; del.title = '删除这一条'; del.textContent = '×';
      del.setAttribute('aria-label', '删除这一条');
      src.addEventListener('input', () => { r.src = src.value; syncApply(); });
      dst.addEventListener('input', () => { r.dst = dst.value; syncApply(); });
      del.addEventListener('click', () => { rows.splice(i, 1); renderRows(); syncApply(); });
      row.append(src, eq, dst, del);
      els.list.appendChild(row);
    });
  }

  function reset() {
    rows = []; scheme = null;
    els.summary.hidden = true;
    els.list.hidden = true;
    els.list.innerHTML = '';
    els.saveWrap.hidden = true;
    els.save.checked = true;
    els.apply.disabled = true;
    els.msg.textContent = '';
  }

  async function open() {
    if (busy) return;
    if (!state.project) { toast('先打开一个稿件，再做全片术语表校对', 3600); return; }
    reset();
    busy = true;
    els.msg.textContent = '正在让模型通读全片，找出中英文专有名词…（长片可能要几十秒）';
    show(true);
    syncApply();
    try {
      const r = await fetch(`/api/projects/${state.project.id}/glossary-review`, {
        method: 'POST', signal: AbortSignal.timeout(300000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      scheme = j.scheme || null;
      rows = (Array.isArray(j.terms) ? j.terms : [])
        .map(t => ({ src: String((t && t.src) || ''), dst: String((t && t.dst) || ''), known: !!(t && t.known) }));
      if (!rows.length) {
        els.msg.textContent = j && j.truncated
          ? '全片较长，本次只通读了前 6 万字，没找到专有名词。'
          : '通读完成，没有在字幕里找到专有名词。';
        return;
      }
      els.msg.textContent = j.truncated
        ? '全片较长，本次只通读了前 6 万字。下面是找到的专有名词，原文和译法都可以直接改。'
        : '通读完成。下面是找到的专有名词，原文和译法都可以直接改。';
      els.summary.hidden = false;
      els.summary.textContent = `共 ${j.total} 条：术语表已有 ${j.known} 条，模型新生成 ${j.total - j.known} 条（亮框提示）`;
      els.list.hidden = false;
      renderRows();
      els.saveWrap.hidden = false;
      els.scheme.textContent = scheme ? `（${scheme.name}）` : '（当前翻译配置）';
      syncApply();
    } catch (e) {
      els.msg.textContent = '校对失败：' + ((e && e.message) || e);
    } finally {
      busy = false;
      syncApply();
    }
  }

  async function apply() {
    if (!state.project) return;
    const pid = state.project.id;
    const terms = rows.map(r => ({ src: r.src.trim(), dst: r.dst.trim() })).filter(t => t.src && t.dst);
    if (!terms.length) { toast('没有可应用的术语：原文和译法都要填', 3600); return; }
    busy = true; syncApply();
    try {
      /* 先把稿件的未保存修改落盘，再让服务端改字幕；否则 openProject() 的 flush 会把
         刚替换好的内容用旧文本覆盖回去。 */
      if (projects && projects.flushSave) { try { await projects.flushSave(); } catch {} }
      const r = await fetch(`/api/projects/${pid}/glossary-apply-project`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terms, saveToScheme: els.save.checked }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      show(false);
      const savedNote = j.saved ? `，并写入${j.scheme ? '「' + j.scheme.name + '」' : ''}术语表` : '';
      if (j.replaced) {
        toast(`已应用到该视频：替换 ${j.replaced} 处（${j.rows} 行）${savedNote}`, 5200);
        if (projects && projects.openProject) { try { await projects.openProject(pid); } catch {} }
      } else {
        toast(`没有在中文轨里找到可替换的原文，字幕未改动${savedNote}`, 5200);
      }
    } catch (e) {
      toast('应用到该视频失败：' + ((e && e.message) || e), 5600);
    } finally {
      busy = false; syncApply();
    }
  }

  btn.addEventListener('click', open);
  els.cancel.addEventListener('click', () => show(false));
  els.apply.addEventListener('click', apply);
  els.save.addEventListener('change', syncApply);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.overlay.hidden) { e.preventDefault(); show(false); }
  });
}
