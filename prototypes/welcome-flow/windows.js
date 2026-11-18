(() => {
  'use strict';

  const { apply, foregroundColor } = window.SF_THEMES;
  const accent = '#5c7560';
  apply({ themePack: 'windows-uwp', accent }, [], true);
  const tokens = document.body.style;
  const surfaces = ['--surface', '--surface-2', '--accent-soft'].map(name => tokens.getPropertyValue(name));
  tokens.setProperty('--accent-text', foregroundColor(accent, surfaces, true));
  for (const tile of document.querySelectorAll('.sf-asr-family')) {
    tile.classList.add('uwp-tile');
    tile.addEventListener('pointermove', event => {
      if (motion.matches) return;
      const rect = tile.getBoundingClientRect();
      tile.style.setProperty('--uwp-face', '1');
      tile.style.setProperty('--uwp-edge', '1');
      tile.style.setProperty('--uwp-mx', (event.clientX - rect.left) + 'px');
      tile.style.setProperty('--uwp-my', (event.clientY - rect.top) + 'px');
    });
    tile.addEventListener('pointerleave', () => {
      tile.style.removeProperty('--uwp-face');
      tile.style.removeProperty('--uwp-edge');
    });
  }
  const byId = id => document.getElementById(id);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const panes = [...document.querySelectorAll('.win-pane')];
  const steps = [...document.querySelectorAll('.win-steps li')];
  const back = byId('win-back'), next = byId('win-next'), skip = byId('win-skip');
  const scroll = byId('win-scroll');
  const backends = [...document.querySelectorAll('input[name=backend]')];
  let page = 0;
  let busy = false;
  let complete = false;

  function animatePane(pane, direction) {
    if (motion.matches) return Promise.resolve();
    return pane.animate([
      { opacity: .12, transform: `translateX(${direction * 17}px)` },
      { opacity: 1, transform: 'translateX(0)' },
    ], { duration: 245, easing: 'cubic-bezier(.18,.75,.24,1)' }).finished;
  }

  const enabledBackends = () => backends.filter(box => box.checked).map(box => box.value);
  function syncFooter() {
    back.hidden = page === 0 || complete;
    skip.hidden = page < 3 || complete;
    back.disabled = skip.disabled = busy;
    next.disabled = busy || (page === 1 && enabledBackends().length === 0);
    next.textContent = complete ? '重新演示' : ['开始配置', '下一步', '下一步', '下一步', '进入工作区'][page];
  }

  async function go(target) {
    if (busy || target < 0 || target >= panes.length) return;
    busy = true;
    const direction = Math.sign(target - page);
    panes[page].hidden = true;
    page = target;
    const pane = panes[page];
    pane.hidden = false;
    scroll.scrollTop = 0;
    byId('win-counter').textContent = `${page + 1} / ${panes.length}`;
    steps.forEach((step, index) => {
      step.classList.toggle('done', index < page);
      if (index === page) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    });
    syncFooter();
    await animatePane(pane, direction);
    busy = false;
    syncFooter();
    pane.querySelector('h1').focus({ preventScroll: true });
  }

  function advance() {
    if (complete) return location.reload();
    if (page < panes.length - 1) return go(page + 1);
    complete = true;
    byId('win-complete').hidden = false;
    syncFooter();
    next.focus();
  }
  back.addEventListener('click', () => go(page - 1));
  next.addEventListener('click', advance);
  skip.addEventListener('click', advance);

  const catalog = {
    'Whisper 系列': [
      { name: 'Faster-Whisper Large V2', desc: 'CUDA · 高精度语音识别', backend: 'cuda', ready: true },
      { name: 'Faster-Whisper Large V3 Turbo', desc: 'CUDA · 快速转写', backend: 'cuda' },
    ],
    'Parakeet 系列': [
      { name: 'Parakeet TDT 0.6B V2', desc: 'Vulkan · 本机语音转写', backend: 'vulkan', ready: true },
    ],
    'Qwen 系列': [
      { name: 'Qwen3-ASR 1.7B', desc: 'CUDA · 本机语音转写', backend: 'cuda', ready: true },
      { name: 'Qwen3-ASR 0.6B', desc: 'Vulkan · 本机语音转写', backend: 'vulkan' },
    ],
    '对齐模型': [
      { name: 'Qwen3-ForcedAligner 0.6B (CUDA)', desc: '重新测量已确认文本的逐词时间', backend: 'cuda', ready: true },
      { name: 'Qwen3-ForcedAligner 0.6B (Vulkan)', desc: '重新测量已确认文本的逐词时间', backend: 'vulkan', ready: true },
    ],
    '云端识别': [
      { name: '必剪', desc: '云端模型 · 按需使用', ready: true },
      { name: '剪映', desc: '云端模型 · 按需使用', ready: true },
    ],
    '前置': [
      { name: 'ffmpeg', desc: '媒体转码与音频准备', ready: true },
      { name: 'Python', desc: 'CUDA 模型运行环境', backend: 'cuda', ready: true },
      { name: '说话人分离', desc: '按需区分同一段音频中的说话人' },
    ],
  };
  const shelf = byId('sf-asr-families');
  const families = [...shelf.querySelectorAll('[data-asr-family]')];
  const detail = byId('win-model-detail');
  let family = '';
  let enteredFrom;

  function visibleModels(name) {
    return (catalog[name] || []).filter(model => !model.backend || enabledBackends().includes(model.backend));
  }
  function syncCatalog() {
    const enabled = enabledBackends();
    byId('win-accel-status').textContent = enabled.length
      ? '已勾选 ' + enabled.map(name => ({ cuda: 'CUDA', vulkan: 'Vulkan' })[name]).join(' 和 ') + '。'
      : '请选择至少一种加速方式。';
    for (const button of families) {
      const name = button.dataset.asrFamily;
      const models = visibleModels(name);
      button.hidden = !models.length;
      if (name === '前置') continue;
      const label = name === '对齐模型' ? '对齐器' : '模型';
      button.querySelector('.sf-asr-count').textContent = `${models.length} 个${label} · ${models.filter(model => model.ready).length} 就绪`;
    }
    syncFooter();
  }

  function modelRow(model) {
    const row = document.createElement('div');
    row.className = family === '前置' ? 'sm-model sf-prerequisite' : 'sm-model';
    row.innerHTML = '<div class="sm-head"><span class="sm-name"></span><span class="sm-actions"></span></div><div class="sm-desc"></div><div class="sm-state" role="status"></div>';
    row.querySelector('.sm-name').textContent = model.name;
    row.querySelector('.sm-desc').textContent = model.desc;
    const status = row.querySelector('.sm-state');
    status.textContent = model.ready ? '✓ 已就绪' : '待准备';
    status.classList.toggle('ok', !!model.ready);
    if (!model.ready) {
      const install = document.createElement('button');
      install.type = 'button';
      install.className = 'btn btn-mini';
      install.textContent = family === '前置' ? '演示准备' : '演示下载';
      install.addEventListener('click', () => {
        install.disabled = true;
        status.textContent = '准备中…';
        setTimeout(() => {
          model.ready = true;
          status.classList.add('ok');
          status.textContent = '✓ 演示完成';
          install.remove();
          syncCatalog();
        }, 650);
      });
      row.querySelector('.sm-actions').append(install);
    }
    return row;
  }

  shelf.addEventListener('click', event => {
    const button = event.target.closest('[data-asr-family]');
    if (!button || button.hidden) return;
    family = button.dataset.asrFamily;
    enteredFrom = button;
    byId('sf-asr-detail-title').textContent = button.querySelector('.sf-asr-family-name').textContent;
    const models = byId('st-models');
    models.dataset.family = family;
    models.replaceChildren(...visibleModels(family).map(modelRow));
    shelf.hidden = true;
    detail.hidden = false;
    byId('sf-asr-detail').hidden = false;
    byId('sf-asr-back').focus({ preventScroll: true });
    void animatePane(detail, 1);
  });
  byId('sf-asr-back').addEventListener('click', () => {
    detail.hidden = true;
    shelf.hidden = false;
    enteredFrom?.focus({ preventScroll: true });
    void animatePane(shelf, -1);
  });
  backends.forEach(box => box.addEventListener('change', () => {
    syncCatalog();
    if (!detail.hidden) byId('sf-asr-back').click();
  }));
  syncCatalog();

  const providers = { deepseek: 'DeepSeek', compatible: 'OpenAI 兼容', anthropic: 'Anthropic' };
  const demoSchemes = [
    { name: 'DeepSeek', provider: 'deepseek', model: 'deepseek-chat' },
    { name: 'OpenAI 兼容', provider: 'compatible', model: 'example-chat' },
    { name: 'Claude 方案', provider: 'anthropic', model: 'claude-example' },
  ];
  let active = demoSchemes[2];
  let editing;
  const list = byId('st-scheme-list'), drawer = byId('st-scheme-drawer'), provider = byId('st-provider');
  const defaults = { 'st-baseurl': '', 'st-temp': '0.3', 'st-batch': '75', 'st-ctx': '0', 'st-prompt': '' };
  const terms = byId('gl-rows');
  const schemeStatus = byId('win-scheme-status');
  const note = message => { schemeStatus.textContent = message; };
  const option = (value, text = value) => new Option(text, value);
  provider.replaceChildren(...Object.entries(providers).map(([value, label]) => option(value, label)));
  byId('st-key').value = 'welcome-example';
  byId('st-key').readOnly = true;
  byId('st-key').closest('.st-card').querySelector('.gl-hint:not([hidden])').textContent = '演示使用示例凭证。';

  function addTerm(source = '', target = '') {
    const row = document.createElement('div');
    row.className = 'gl-row';
    row.innerHTML = '<input class="gl-input" aria-label="原文"><input class="gl-input" aria-label="译法"><button class="gl-del" type="button" aria-label="删除词条">×</button>';
    const [left, right] = row.querySelectorAll('input');
    left.value = source;
    right.value = target;
    row.querySelector('button').addEventListener('click', () => row.remove());
    terms.append(row);
    return left;
  }
  byId('gl-add').addEventListener('click', () => addTerm().focus());

  function closeEditor() {
    drawer.classList.remove('open');
    drawer.hidden = drawer.inert = true;
    drawer.setAttribute('aria-hidden', 'true');
    list.after(drawer);
    for (const row of list.querySelectorAll('.sf-scheme-open')) row.setAttribute('aria-expanded', 'false');
  }

  function showEditor(scheme, row) {
    closeEditor();
    editing = scheme;
    byId('st-scheme-title').textContent = scheme ? '编辑方案' : '添加方案';
    byId('st-scheme-name').value = scheme?.name || '';
    provider.value = scheme?.provider || 'deepseek';
    byId('st-model').value = scheme?.model || '';
    for (const [id, value] of Object.entries(defaults)) byId(id).value = scheme?.fields?.[id] ?? value;
    terms.replaceChildren();
    for (const pair of scheme?.terms ?? []) addTerm(...pair);
    byId('st-scheme-activate').checked = !scheme || scheme === active;
    byId('st-model-options').hidden = true;
    byId('st-model-list-status').hidden = true;
    byId('st-model-discover').hidden = false;
    byId('st-drawer-msg').textContent = '';
    byId('st-scheme-cur').hidden = !scheme || scheme !== active;
    if (row) {
      row.after(drawer);
      row.querySelector('.sf-scheme-open').setAttribute('aria-expanded', 'true');
    }
    drawer.hidden = drawer.inert = false;
    drawer.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      if (drawer.hidden) return;
      drawer.classList.add('open');
      byId('st-scheme-name').focus({ preventScroll: true });
      drawer.scrollIntoView({ block: 'nearest' });
    });
  }

  function renderSchemes() {
    closeEditor();
    list.replaceChildren();
    for (const scheme of demoSchemes) {
      const row = document.createElement('div');
      row.className = 'st-scheme' + (scheme === active ? ' cur' : '');
      // Same card structure as project.js renderSavedSchemes, with sample records.
      row.innerHTML = '<button type="button" class="sf-scheme-open" aria-expanded="false" aria-controls="st-scheme-drawer"><span class="st-scheme-name"></span><span class="st-scheme-desc"></span></button><button type="button" class="btn btn-mini sf-scheme-use">使用</button><button type="button" class="btn btn-mini sf-scheme-delete">删除</button>';
      const name = row.querySelector('.st-scheme-name');
      name.textContent = scheme.name;
      if (scheme === active) {
        const tag = document.createElement('span');
        tag.className = 'st-tag-cur';
        tag.textContent = '当前使用';
        name.append(tag);
      }
      row.querySelector('.st-scheme-desc').textContent = providers[scheme.provider] + ' · ' + scheme.model;
      row.querySelector('.sf-scheme-open').addEventListener('click', () => {
        if (editing === scheme && !drawer.hidden) closeEditor();
        else showEditor(scheme, row);
      });
      const use = row.querySelector('.sf-scheme-use');
      use.disabled = scheme === active;
      use.addEventListener('click', () => { active = scheme; renderSchemes(); note('已切换示例方案。'); });
      row.querySelector('.sf-scheme-delete').addEventListener('click', () => {
        demoSchemes.splice(demoSchemes.indexOf(scheme), 1);
        if (scheme === active) active = demoSchemes[0];
        renderSchemes();
        note('已移除示例方案。');
      });
      list.append(row);
    }
  }
  byId('st-scheme-new').addEventListener('click', () => showEditor());
  byId('st-scheme-import').addEventListener('click', () => {
    if (!demoSchemes.some(scheme => scheme.name === '导入示例')) {
      demoSchemes.push({ name: '导入示例', provider: 'compatible', model: 'imported-example' });
      renderSchemes();
    }
    note('已导入一份示例方案。');
  });
  byId('st-scheme-export').addEventListener('click', () => note('可导出的示例方案共 ' + demoSchemes.length + ' 套。'));
  byId('st-scheme-close').textContent = '×';
  for (const button of ['st-scheme-close', 'st-drawer-cancel']) byId(button).addEventListener('click', closeEditor);
  byId('st-scheme-test').addEventListener('click', () => { byId('st-drawer-msg').textContent = '示例测试完成。'; });
  byId('st-scheme-reset').addEventListener('click', () => {
    for (const [id, value] of Object.entries(defaults)) byId(id).value = value;
  });
  const options = byId('st-model-options');
  byId('st-model-discover').addEventListener('click', () => {
    const models = provider.value === 'deepseek' ? ['deepseek-chat', 'deepseek-example'] : ['example-chat', 'example-fast'];
    options.replaceChildren(option('', '选择示例模型'), ...models.map(name => option(name)));
    options.hidden = false;
  });
  options.addEventListener('change', () => {
    if (options.value) byId('st-model').value = options.value;
  });
  byId('st-key-eye').addEventListener('click', event => {
    const key = byId('st-key');
    key.type = key.type === 'password' ? 'text' : 'password';
    event.target.textContent = key.type === 'password' ? '显示' : '隐藏';
  });
  byId('st-drawer-save').addEventListener('click', () => {
    const name = byId('st-scheme-name').value.trim(), model = byId('st-model').value.trim();
    if (!name || !model) {
      byId('st-drawer-msg').textContent = '请填写方案名称和模型。';
      return;
    }
    const record = editing || {};
    const fields = Object.fromEntries(Object.keys(defaults).map(id => [id, byId(id).value]));
    const glossary = [...terms.children].map(row => [...row.querySelectorAll('input')].map(input => input.value.trim()));
    Object.assign(record, { name, provider: provider.value, model, fields, terms: glossary.filter(pair => pair.every(Boolean)) });
    if (!editing) demoSchemes.push(record);
    if (byId('st-scheme-activate').checked) active = record;
    renderSchemes();
    note('已保存示例方案。');
  });
  renderSchemes();

  const dialog = byId('win-account-dialog');
  let accountButton;
  document.querySelectorAll('[data-account]').forEach(button => button.addEventListener('click', () => {
    accountButton = button;
    dialog.returnValue = '';
    byId('win-account-title').textContent = button.dataset.account + ' · ' + button.textContent;
    dialog.showModal();
  }));
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'accept') return;
    const result = document.createElement('span');
    result.className = 'sm-state ok';
    result.setAttribute('role', 'status');
    result.textContent = accountButton.dataset.account === 'bilibili' ? '模拟已登录' : '模拟已导入';
    accountButton.replaceWith(result);
    next.focus();
  });
})();
