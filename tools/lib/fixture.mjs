/* 探针用的临时项目 fixture。
 *
 * 「详细信息」页要看的是**有 source（链接元数据）+ 有 draft（初稿进度）**那条路径，
 * 而用户自己的项目不一定带 source。所以探针自己造一个、跑完删掉，
 * 让 `node tools/<probe>.mjs` 成为完整契约，不依赖手工准备的数据。
 *
 * 数据落在仓库根的 projects/<id>/（server.js 的 ROOT 是仓库根，不是 editor/）。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const FIXTURE_ID = 'p-wsprobe-0001';
export const FIXTURE_DIR = join(REPO_ROOT, 'projects', FIXTURE_ID);

/** 造一个带 source + draft 的项目；缩略图用内联 SVG，探针不依赖外网 */
export function makeProbeProject({ id = FIXTURE_ID, dir = FIXTURE_DIR } = {}) {
  const thumb = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#2b2b3a"/>'
    + '<text x="320" y="190" font-size="34" fill="#ff7a45" text-anchor="middle">THUMB</text></svg>');
  const now = new Date().toISOString();
  const meta = {
    id, name: '【探针】2×2 工作台验证用项目', nameCustomized: true, createdAt: now, modifiedAt: now,
    video: { path: join(REPO_ROOT, 'probe.mp4'), name: 'probe.mp4' },
    prepare: { status: 'done', finishedAt: now, error: null, duration: 3725.5, rate: 100, mode: 'denoise' },
    subtitle: { format: 'ass', file: 'subtitle.ass', name: 'probe.ass' },
    duration: 3725.5,
    source: {
      url: 'https://www.bilibili.com/video/BV1GJ411x7h7', site: 'bilibili', id: 'BV1GJ411x7h7',
      title: '【探针】这是一条很长的标题，用来验证稿件预览面板在窄列里会不会把面板撑破或者把其他信息挤下去',
      uploader: 'SubFabric 探针账号', description: '这是简介。'.repeat(20),
      duration: 3725.5, uploadDate: '2026-10-01', tags: ['字幕', '探针'], viewCount: 123456,
      thumbnail: thumb, height: 1080, qualityPreset: '1080p', fileSize: 0, fetchedAt: now,
    },
    draft: {
      words: 1200, lines: 180, status: 'done', stage: '完毕', progress: 100,
      message: '初稿已生成：180 行（含中文译文）', error: null, wordLevel: true, translated: true,
      needTranslate: false, modelId: 'parakeet-tdt-0.6b-v2', engine: 'sherpa-onnx',
      speakers: true, speakerCount: 4, startedAt: now, failedStage: '', resegDone: true,
      pendingTranslate: 0, finishedAt: now,
    },
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(meta, null, 2));
  writeFileSync(join(dir, 'subtitle.ass'),
    '[Script Info]\nTitle: probe\nScriptType: v4.00+\n\n[V4+ Styles]\n'
    + 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
    + 'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,30,1\n\n'
    + '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
    + 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,probe line one\n'
    + 'Dialogue: 0,0:00:03.50,0:00:05.00,Default,,0,0,0,,probe line two\n');
  writeFileSync(join(dir, 'draft.log'), '[probe] 初稿已生成\n');
  return { id, dir };
}

/** 只删自己造的那一个目录（名字是常量，不做通配） */
export function removeProbeProject({ dir = FIXTURE_DIR } = {}) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
