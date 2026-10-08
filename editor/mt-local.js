/**
 * 本地翻译引擎（NLLB-200 / CTranslate2）—— SubFabric 的「本地模型」翻译后端。
 *
 * 为什么不给 SubFabric 引入 npm 依赖：
 *   另一条路是用 Transformers.js + onnxruntime-node 在 Node 里跑 NLLB，但 onnxruntime-node
 *   是 **287MB 的原生二进制**（分平台），而 SubFabric 是零 npm 依赖的仓库。CTranslate2 版
 *   模型只要 model.bin + 词表，Python 侧几十行就能跑，还自带 CUDA 支持。
 *
 * 形态：**常驻子进程 + 本机 HTTP**。
 *   NLLB 加载一次要十几秒、占 600MB 内存，而翻译是逐批往返的（默认 25 行一批）——
 *   每批都重新加载模型是不可接受的，所以起一次服务、之后走 127.0.0.1 的 HTTP。
 *   服务只监听本机回环，随 SubFabric 退出一起收掉（见 killLocalMt）。
 *
 * 与 LLM 引擎的区别（对上层透明）：
 *   * 不需要 API Key、不联网；
 *   * 对"每批 25 行"这种批量是原生批处理，实测 RTX 4060 上 18ms/行（CPU 57ms/行）；
 *   * 但**不会**做术语表/角色语气/语义分句 —— 那些是提示词工程的产物。所以术语表在
 *     本引擎上以「译后替换」的形式生效（见 applyGlossary），而不是塞进提示词。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 语言短码 → NLLB 标记（子集按需扩充）。 */
export const NLLB_LANGS = {
  en: 'eng_Latn', zh: 'zho_Hans', 'zh-Hant': 'zho_Hant', ja: 'jpn_Jpan',
  ko: 'kor_Hang', fr: 'fra_Latn', de: 'deu_Latn', es: 'spa_Latn',
  ru: 'rus_Cyrl', pt: 'por_Latn', it: 'ita_Latn', ar: 'arb_Arab',
  th: 'tha_Thai', vi: 'vie_Latn', hi: 'hin_Deva', id: 'ind_Latn',
  nl: 'nld_Latn', pl: 'pol_Latn', tr: 'tur_Latn', uk: 'ukr_Cyrl',
};

/** 模型目录的候选位置：仓库内优先，其次环境变量指定的位置。 */
export function modelCandidates(repoRoot) {
  const out = [];
  const env = process.env.SUBFABRIC_MT_MODEL;
  if (env) out.push(env);
  const name = 'nllb-200-distilled-600M-ct2-int8';
  out.push(path.join(repoRoot, 'asr', 'models', name));
  out.push(path.join(repoRoot, 'models', name));
  // 仓库可能不在"模型所在的那棵树"里（例如仓库在 D:\ 而模型在工作区）：向上逐级找兄弟
  // 目录下的 models/。**只认真正含 model.bin 的目录**，不会误命中。
  try {
    let dir = path.resolve(repoRoot);
    for (let i = 0; i < 4; i++) {
      const parent = path.dirname(dir);
      if (!parent || parent === dir) break;
      out.push(path.join(parent, 'models', name));
      dir = parent;
    }
  } catch { /* 路径异常就算了 */ }
  return out;
}

export function findModel(repoRoot) {
  for (const dir of modelCandidates(repoRoot)) {
    try {
      if (fs.existsSync(path.join(dir, 'model.bin')) && fs.existsSync(path.join(dir, 'tokenizer.json'))) {
        return dir;
      }
    } catch { /* 忽略权限等问题，继续找 */ }
  }
  return null;
}

export class LocalMt {
  /** @param {{repoRoot:string, pythonExe?:string, onLog?:(s:string)=>void}} opts */
  constructor(opts) {
    this.repoRoot = opts.repoRoot;
    this.pythonExe = opts.pythonExe || process.env.SUBFABRIC_MT_PYTHON || 'python';
    this.onLog = opts.onLog || (() => {});
    this.proc = null;
    this.port = 0;
    this.starting = null;
    this.model = null;
    this.device = process.env.SUBFABRIC_MT_DEVICE || 'auto';
  }

  /** 服务脚本与模型的就位情况（状态页/设置页用来告诉用户缺什么）。 */
  probe() {
    const script = path.join(this.repoRoot, 'asr', 'mt_nllb.py');
    const model = findModel(this.repoRoot);
    return {
      script, scriptOk: fs.existsSync(script),
      model, modelOk: !!model,
      python: this.pythonExe,
      running: !!(this.proc && this.port),
      port: this.port,
      device: this.device,
    };
  }

  /** 启动服务（幂等）。返回端口；同时被多次调用时复用同一个启动过程。 */
  async ensure() {
    if (this.proc && this.port) return this.port;
    // 测试/外部托管用：环境变量直接指定端口，跳过子进程管理
    const forced = Number(process.env.SUBFABRIC_MT_PORT || 0);
    if (forced > 0) { this.port = forced; return forced; }
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const p = this.probe();
      if (!p.scriptOk) throw new Error(`找不到本地翻译服务脚本：${p.script}`);
      if (!p.modelOk) {
        throw new Error(
          '找不到本地翻译模型（NLLB-200 CTranslate2 版）。\n'
          + `预期位置：\n  ${modelCandidates(this.repoRoot).join('\n  ')}\n`
          + '可以运行 python tools/download-mt-nllb.py 下载（约 617MB）');
      }
      this.model = p.model;
      const args = [p.script, '--model', p.model, '--port', '0'];
      if (this.device && this.device !== 'auto') args.push('--device', this.device);
      this.onLog(`[mt-local] 启动本地翻译服务：${this.pythonExe} (${this.device})`);

      const proc = spawn(this.pythonExe, args, {
        windowsHide: true, cwd: this.repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.proc = proc;
      proc.on('close', () => { this.proc = null; this.port = 0; this.starting = null; });
      proc.on('error', (e) => {
        this.proc = null; this.port = 0; this.starting = null;
        this.onLog(`[mt-local] 启动失败：${e.message}`);
      });

      const port = await new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => {
          try { proc.kill(); } catch {}
          reject(new Error('本地翻译服务 90 秒内没有就绪（首次启动要载入模型，也可能模型损坏）'));
        }, 90000);
        const onData = (chunk) => {
          buf += String(chunk);
          this.onLog(`[mt-local] ${String(chunk).trim()}`);
          const m = /PORT=(\d+)/.exec(buf);
          if (m) { clearTimeout(timer); resolve(Number(m[1])); }
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
      });
      this.port = port;
      this.onLog(`[mt-local] 已就绪，端口 ${port}`);
      return port;
    })();

    try { return await this.starting; }
    finally { if (!this.port) this.starting = null; }
  }

  /** 翻译一批。srcLang/tgtLang 用短码（en/zh/zh-Hant…）。 */
  async translate(texts, srcLang = 'en', tgtLang = 'zh', maxNewTokens = 256) {
    const port = await this.ensure();
    const res = await fetch(`http://127.0.0.1:${port}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts, src: srcLang, tgt: tgtLang, maxNewTokens }),
      signal: AbortSignal.timeout(600000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !Array.isArray(body.texts)) {
      throw new Error((body && body.error) || `本地翻译服务返回 HTTP ${res.status}`);
    }
    return { texts: body.texts, ms: body.ms, device: body.device };
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    this.port = 0;
    this.starting = null;
    if (!p) return;
    try { p.kill(); } catch {}
  }
}

/** 术语表在本地引擎上的落地方式：**译后替换**。
 *  本地模型没有提示词可塞，所以把"原文=译法"按译法直接替换译文里的对应词 ——
 *  效果不如提示词工程，但比完全忽略术语表好，而且行为可预测。 */
export function applyGlossary(pairs, translated) {
  if (!Array.isArray(pairs) || !pairs.length) return translated;
  return translated.map((t) => {
    let out = String(t || '');
    for (const [src, dst] of pairs) {
      if (!src || !dst) continue;
      // 术语表里可能写的是英文原文；译文里一般不会出现英文，所以也试它的译法是否被翻歪
      out = out.split(src).join(dst);
    }
    return out;
  });
}
