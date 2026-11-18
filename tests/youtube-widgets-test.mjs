/* MY 主页主播最近更新：四位 YouTuber、5 分钟刷新、手动刷新、断网保留缓存。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { isolatedServer } from './helpers/isolated-server.mjs';
const root = path.resolve(import.meta.dirname, '..');
const template = fs.readFileSync(path.join(root, 'tools/templates/studio.html'), 'utf8');
const studio = fs.readFileSync(path.join(root, 'editor/js/studio.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'editor/server.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'editor/css/studio.css'), 'utf8');
assert.match(template, /id="sf-mu-youtube"[\s\S]*?id="sf-mu-yt-grid"/, '主页有主播更新组件');
assert.doesNotMatch(template, /sf-mu-yt-head|sf-mu-yt-refresh/, '主播区不显示标题和刷新按钮');
for (const name of ['Wemmbu', 'Parrot', 'Spoke', 'FlameFrags']) assert.ok(server.includes(`name: '${name}'`), '服务器配置 ' + name);
assert.match(server, /feeds\/videos\.xml\?channel_id=/, '从 YouTube RSS 爬取最近视频');
assert.match(server, /"externalId":"\(UC/, '频道页兼容 externalId');
assert.match(server, /youtubePowerShellFetch/, 'Node 直连失败时走系统代理 PowerShell 回退');
assert.match(server, /UCkzzNLnuM-VsATWC53ehwOQ/, 'Wemmbu 主频道 ID 固定');
assert.match(server, /mqdefault\.jpg/, '封面使用 16:9 mqdefault，避免黑边');
assert.match(server, /youtube-updates\.json/, '缓存落盘');
assert.match(template, /id="st-panel-theme"[\s\S]*?id="sf-youtube-follows"[\s\S]*?class="hotword-list"/, '名单在外观与体验复用热词布局');
assert.match(studio, /\$\{d\.getFullYear\(\)\}-\$\{pad\(d\.getMonth\(\) \+ 1\)\}/, '更新时间显示绝对日期时间');
assert.match(studio, /function ytRecentWeekCount[\s\S]*?7 \* 86400000/, '圆环胶囊统计一周内更新视频');
assert.match(template, /一周内更新/, '胶囊文案改为近期更新数');
assert.match(studio, /YT_REFRESH_MS = 5 \* 60 \* 1000/, '5 分钟自动刷新');
assert.match(studio, /sf-mu-temp.*loadYoutubeUpdates\(true\)/, '胶囊点击手动刷新');
assert.match(studio, /extractSeedCandidatesFromImageSrc\(video\.thumbnail, \{ cors: true, count: 3/, '封面取三种莫奈主题色');
assert.match(studio, /--yt-flow/, '卡片生成静态三色流光');
assert.match(css, /background-image:var\(--yt-flow/, '卡片应用封面流光背景');
assert.match(css, /\.sf-mu-yt-grid/, '四宫格布局');
assert.match(css, /\.sf-mu-yt-card:hover \{[^}]*translateY\(-4px\)[^}]*box-shadow/, '主播卡悬浮上浮并加阴影');
assert.match(css, /#sf-mu-yt-grid > \.sf-mu-yt-card/, '主播卡逐个浮现');
assert.match(css, /\.sf-mu \{ padding-top:64px; \}/, 'MY 主页元素整体下移');
/* Windows 10 主页：加宽画布 + 底部主播行（2026-11-04）。 */
assert.match(template, /id="sf-uwp-youtube"[\s\S]*?id="sf-uwp-yt-grid"/, 'Windows 10 主页底部有主播更新行');
assert.match(template, /id="sf-uwp-yt-refresh"/, '主播行提供手动刷新按钮');
assert.match(studio, /function renderUwpYoutube\(\)/, 'Windows 10 主播行渲染四张磁贴');
assert.match(studio, /YT_CHANNEL_TONES/, '主播磁贴使用频道色');
assert.match(studio, /function ytSortedChannels[\s\S]*?return bt - at;/, '主播按发布时间从新到旧排序');
assert.match(studio, /sf-uwp-yt-refresh'\)\?\.addEventListener\('click', \(\) => loadYoutubeUpdates\(true\)\)/, '刷新按钮强制刷新主播数据');
assert.match(studio, /uwpYtSignature/, '项目快照刷新不会重建主播磁贴');
assert.match(studio, /sf-uwp-yt-grid > \.sf-uwp-yt-card/, '主播磁贴参与 Windows 10 页面入场');
assert.match(css, /\.sf-studio\[data-design=uwp\] \.dashboard-inner \{[\s\S]*?1108px/, 'Windows 10 主页内容加宽到 1040（含 34px 边距）');
assert.match(css, /\.sf-uwp-yt-grid \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/, '主播行是四列磁贴');
assert.match(studio, /uwpGlowCards[\s\S]*?sf-uwp-yt-card/, '主播磁贴共用靠近点亮边框');
assert.doesNotMatch(studio, /sf-uwp-yt-play/, '主播磁贴不再渲染播放按钮');
assert.doesNotMatch(css, /\.sf-uwp-yt-play/, '主播磁贴不再有播放按钮样式');
assert.match(css, /is-uwp-tile-leaving :is\(\.dashboard-head,\.dashboard-foot,\.sf-uwp-yt-head\)/, '点磁贴离场时非磁贴文字立即淡出');
const start = server.indexOf('const YOUTUBE_CHANNELS =');
const end = server.indexOf('let desktopUpdateState;', start);
const fixtures = new Map(), outbound = [];
const channelId = 'UC' + 'A'.repeat(22);
const videoId = 'testvideo01';
const channelPage = 'https://www.youtube.com/@%E5%B0%8F%E6%98%8E/videos';
const feed = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + channelId;
fixtures.set(channelPage, '{"externalId":"' + channelId + '"}');
fixtures.set(feed, '<feed><author><name>频道显示名</name></author><entry><yt:videoId>' + videoId
  + '</yt:videoId><title>新视频</title><published>2026-01-01T12:34:56Z</published></entry></feed>');
fixtures.set('https://www.youtube.com/watch?v=' + videoId, '{"lengthSeconds":"120"}');
let inputs;
const saved = new Map();
const { youtubeChannelInput, youtubeConfiguredChannels, youtubeUpdates } = runInNewContext(
  server.slice(start, end) + '\n({ youtubeChannelInput, youtubeConfiguredChannels, youtubeUpdates });', {
    ROOT: '/fixture', path, URL, AbortSignal, process: { platform: 'linux' },
    fs: {
      readFileSync: file => saved.get(file) || '',
      mkdirSync() {},
      writeFileSync: (file, value) => saved.set(file, value),
      renameSync: (from, to) => { saved.set(to, saved.get(from)); saved.delete(from); },
    },
    readAsrSettings: () => ({ youtubeChannels: inputs }),
    fetch: async url => {
      outbound.push(url);
      if (!fixtures.has(url)) throw Error('fixture offline');
      return new Response(fixtures.get(url));
    },
  }
);
assert.equal(youtubeConfiguredChannels().length, 4, 'existing installs retain the original four defaults');
assert.equal(youtubeChannelInput('m.youtube.com/@%E5%B0%8F%E6%98%8E/featured?si=share'), '@小明');
assert.equal(youtubeChannelInput('https://youtube.com/channel/' + channelId), 'https://www.youtube.com/channel/' + channelId);
assert.equal(youtubeChannelInput('https://youtube.com/c/ClassicCreator/videos'), 'https://www.youtube.com/c/ClassicCreator');
assert.equal(youtubeChannelInput('https://youtube.com/user/OldCreator/'), 'https://www.youtube.com/user/OldCreator');
for (const invalid of ['https://youtube.com.example.org/@foo', 'https://youtube.com/watch?v=foo',
  'https://youtube.com:8080/@foo', 'https://youtube.com/@foo%2Fbar', 'https://www.youtube.com/@foo/videos/extra',
  'https://youtu.be/example', 'http://www.youtube.com@localhost/@foo', 'file:///youtube.com/@foo']) {
  assert.equal(youtubeChannelInput(invalid), null, invalid);
}
assert.equal(youtubeConfiguredChannels(['@Creator', 'https://youtube.com/@creator']).length, 1);
inputs = ['@小明'];
const data = await youtubeUpdates(true);
assert.equal(data.channels[0].name, '频道显示名');
assert.equal(data.channels[0].video.duration, 120);
assert.equal(outbound[0], channelPage, 'only a canonical YouTube channel URL is fetched');
fixtures.set(channelPage, '{"key":"browse_id","value":"' + channelId + '"}');
inputs = ['@小明', 'https://youtube.com/channel/' + channelId];
assert.equal((await youtubeUpdates(true)).channels.length, 1, 'different aliases of one resolved channel share a card');
fixtures.clear();
const offline = await youtubeUpdates(true);
assert.equal(offline.stale, true, 'failed refresh reported');
assert.equal(offline.channels[0].video.id, videoId, 'saved video is retained offline');
fixtures.set(feed, '<feed><yt:channelId>' + channelId.slice(2) + '</yt:channelId><author><name>空频道</name></author></feed>');
const noVideos = await youtubeUpdates(true);
assert.equal(noVideos.channels[0].name, '空频道', 'a recognized channel with no videos retains its name');
assert.equal(noVideos.channels[0].video, null);
inputs = [];
const networkCount = outbound.length;
assert.equal((await youtubeUpdates(true)).channels.length, 0, 'empty follows do not resurrect defaults');
assert.equal(outbound.length, networkCount, 'empty follows skip network access');

const api = await isolatedServer();
try {
  const config = '/api/youtube/channels';
  const put = inputs => api.call(config, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inputs }),
  });
  assert.equal((await (await api.call(config)).json()).inputs.length, 4);
  api.settings({ asr: { prompt: 'other settings remain' } });
  const save = await put(['@OtherCreator', 'https://youtube.com/@othercreator/videos']);
  assert.equal(save.status, 200);
  const committed = await save.json();
  assert.deepEqual(committed.inputs, ['@OtherCreator']);
  assert.equal(committed.channels.length, 1);
  const bad = await put(['@OtherCreator', 'https://example.org/@somebody']);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).invalid, 1);
  assert.deepEqual((await (await api.call(config)).json()).inputs, ['@OtherCreator']);
  assert.equal((await put([])).status, 200);
  assert.deepEqual((await (await api.call('/api/youtube/updates?refresh=1')).json()).channels, []);
  const settings = JSON.parse(fs.readFileSync(path.join(api.root, 'asr/settings.json'), 'utf8'));
  assert.deepEqual(settings, { asr: { prompt: 'other settings remain' }, youtubeChannels: [] });
} finally { await api.close(); }
console.log('youtube-widgets: channel formats, default migration, API persistence, offline cache and empty follows passed');
