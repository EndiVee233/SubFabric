'use strict';

const LOGIN_URL = 'https://passport.bilibili.com/login';
const LOGIN_ROUTE = '/api/fetch/bilibili-login';
const LOGIN_HOSTS = new Set(['passport.bilibili.com', 'www.bilibili.com']);
const LOGIN_TIMEOUT = 4 * 60 * 1000;

function allowedLoginURL(raw) {
  const url = URL.parse(raw);
  return !!url && url.protocol === 'https:' && !url.port && !url.username && !url.password && LOGIN_HOSTS.has(url.hostname);
}

function sessionValue(cookie) {
  if (cookie?.name !== 'SESSDATA' || !cookie.secure || !['.bilibili.com', 'bilibili.com'].includes(cookie.domain)
    || cookie.path !== '/' || typeof cookie.value !== 'string' || !/^[^\s;\x00-\x1f\x7f]{1,4096}$/.test(cookie.value)) return '';
  return cookie.value;
}

function createBilibiliLogin({ BrowserWindow, session, backend, parent, fetcher = fetch }) {
  const loginSession = session.fromPartition('subfabric-bilibili-login', { cache: false });
  loginSession.setPermissionCheckHandler(() => false);
  loginSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  // Prevent this temporary session from creating any files in the download folder.
  loginSession.on('will-download', event => event.preventDefault());
  const publish = state => {
    if (backend.child.connected) backend.child.send({ type: 'subfabric-bilibili-login-state', state }, () => {});
  };
  let active;
  publish('idle');

  function open() {
    if (active) { active.window?.focus(); return; }
    if (parent.isDestroyed()) return;
    const controller = new AbortController();
    active = { window: null, close: () => finish('cancelled') };
    let checking = false, finished = false;
    const timeout = setTimeout(() => finish('timeout'), LOGIN_TIMEOUT);

    function finish(state) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      controller.abort();
      loginSession.cookies.removeListener('changed', onCookieChanged);
      if (active.window && !active.window.isDestroyed()) active.window.destroy();
      // Keep the partition busy until all previous login data has been cleared.
      void loginSession.clearStorageData().catch(() => {}).finally(() => {
        active = null;
        publish(state);
      });
    }
    async function onCookieChanged(_event, cookie, _cause, removed) {
      const value = removed ? '' : sessionValue(cookie);
      if (!value || finished || checking) return;
      checking = true;
      try {
        const response = await fetcher(backend.origin + LOGIN_ROUTE + '/complete', {
          method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json', 'X-SubFabric-Token': backend.token },
          body: JSON.stringify({ session: value }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(18000)]),
        });
        void response.body?.cancel().catch(() => {});
        finish(response.ok ? 'saved' : 'error');
      } catch { finish('error'); }
    }

    publish('pending');
    void loginSession.clearStorageData().then(async () => {
      if (finished) return;
      const window = new BrowserWindow({
        parent, width: 900, height: 720, minWidth: 640, minHeight: 520, title: 'bilibili 登录',
        autoHideMenuBar: true, webPreferences: {
          session: loginSession, sandbox: true, contextIsolation: true,
          nodeIntegration: false, devTools: false, webSecurity: true,
        },
      });
      active.window = window;
      window.removeMenu();
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const guard = (event, url, _inPlace, isMainFrame) => {
        if ((event.isMainFrame ?? isMainFrame) === false) return;
        if (!allowedLoginURL(event.url || url)) event.preventDefault();
      };
      window.webContents.on('will-navigate', guard);
      window.webContents.on('will-redirect', guard);
      window.webContents.on('will-attach-webview', event => event.preventDefault());
      window.on('page-title-updated', event => event.preventDefault());
      window.on('close', () => finish('cancelled'));
      window.on('closed', () => finish('cancelled'));
      window.webContents.on('render-process-gone', () => finish('error'));
      loginSession.cookies.on('changed', onCookieChanged);
      await window.loadURL(LOGIN_URL).catch(error => {
        // Redirects and an ordinary close can abort the initial Chromium navigation.
        if (error.code !== 'ERR_ABORTED' && !window.isDestroyed()) throw error;
      });
    }).catch(() => finish('error'));
  }

  return { open, close: () => active?.close() };
}

module.exports = { LOGIN_ROUTE, allowedLoginURL, sessionValue, createBilibiliLogin };
