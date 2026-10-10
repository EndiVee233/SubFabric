/**
 * ASR 常驻服务：让识别引擎的 Python 进程只启动一次、模型只加载一次。
 *
 * 为什么值得（实测，同一段 40 秒音频）：
 *   引擎                              冷启动一次   常驻后每次    省
 *   NPU（OpenVINO）                     6.36s        1.09s     5.3s（83%）
 *   GPU（sherpa-onnx / CUDA）          12.52s        2.23s    10.3s（82%）
 * 那笔差额是"启动 Python 进程 + 导入 OpenVINO / sherpa-onnx 运行时 + 加载模型"，
 * 与音频长度无关 —— 于是短视频、单句重识别、逐片并行全都被它拖累。
 * 我早期在进程内测的持续吞吐（21.9x / 16.1x）没算这笔账，所以和真实调用路径对不上。
 *
 * 协议（worker 侧见 asr_npu.py / asr.py 的 `--serve`）：
 *   worker → stdout   {"type":"ready"} / {"type":"ok","id":N,…} / {"type":"error","id":N,…}
 *   server → stdin    {"cmd":"transcribe","id":N,"audio":…,"tta":N} / {"cmd":"quit"}
 *   worker → stderr   newline-JSON 的 log/progress（本模块原样转发，保持日志面板不变）
 *
 * 生命周期：按 (脚本, 模型, provider) 缓存实例；空闲超时后关掉（免得几十 GB 模型常驻内存）；
 *           server 退出时统一 quit。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const IDLE_MS = 5 * 60 * 1000;        // 空闲 5 分钟就收掉，别让模型一直占内存

/** 能跑常驻服务的引擎（脚本名 → 是否支持）。whisper.cpp/cloud 走自己的路径。 */
export function serviceKey(script, model, provider) {
  return `${path.basename(script)}|${model}|${provider}`;
}

class Worker {
  constructor(opts) {
    this.key = opts.key;
    this.python = opts.python;
    this.script = opts.script;
    this.model = opts.model;
    this.provider = opts.provider;
    this.extra = opts.extra || [];
    this.onLog = opts.onLog || (() => {});
    this.proc = null;
    this.buf = '';
    this.pending = new Map();          // id → {resolve, reject, out, timer}
    this.nextId = 1;
    this.ready = false;
    this.readyWaiters = [];
    this.idleTimer = null;
  }

  start() {
    if (this.proc) return;
    const args = [this.script, '--model', this.model, '--serve',
                  '--provider', this.provider, ...this.extra];
    this.onLog(`[asr-serve] 启动常驻识别进程：${path.basename(this.script)} (${this.provider})`);
    this.proc = spawn(this.python, args, {
      windowsHide: true, cwd: path.dirname(this.script), stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (c) => this._onStdout(String(c)));
    this.proc.stderr.on('data', (c) => {
      for (const line of String(c).split('\n')) {
        const t = line.trim();
        if (t) this.onLog(t);          // 进度/日志原样转发（server 会解析 progress）
      }
    });
    this.proc.on('close', (code) => {
      this.ready = false;
      this.proc = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`常驻识别进程退出（代码 ${code}）`));
      }
      this.pending.clear();
      // ready 之前就退出（模型损坏/依赖崩溃）也要唤醒 waitReady —— 否则它干等满
      // 180s 超时才失败，初稿流水线白白卡 3 分钟。
      for (const w of this.readyWaiters) {
        try { w.reject(new Error(`常驻识别进程退出（代码 ${code}），模型未就绪`)); } catch {}
      }
      this.readyWaiters = [];
    });
    this.proc.on('error', (e) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('常驻识别进程启动失败：' + e.message));
      }
      this.pending.clear();
      for (const w of this.readyWaiters) {
        try { w.reject(new Error('常驻识别进程启动失败：' + e.message)); } catch {}
      }
      this.readyWaiters = [];
    });
  }

  _onStdout(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      let obj = null;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type === 'ready') {
        this.ready = true;
        this.onLog('[asr-serve] 就绪（模型已加载，后续识别不再重载）');
        for (const w of this.readyWaiters) w.resolve();
        this.readyWaiters = [];
        continue;
      }
      const p = this.pending.get(obj.id);
      if (!p) continue;
      this.pending.delete(obj.id);
      clearTimeout(p.timer);
      if (obj.type === 'error') p.reject(new Error(obj.msg || '识别失败'));
      else p.resolve(obj);
    }
  }

  waitReady(timeoutMs = 180000) {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(
        `常驻识别进程 ${timeoutMs / 1000}s 内没有就绪（首次要编译/加载模型，也可能是模型损坏）`)),
        timeoutMs);
      // reject 也要存进 waiter: 进程在 ready 前崩溃时 close/error 要能逐个唤醒（见那边）
      this.readyWaiters.push({
        resolve: () => { clearTimeout(t); resolve(); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
    });
  }

  /** 送一次识别任务。返回 worker 的 ok 消息（含 segments）。 */
  transcribe(job, outPath) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('常驻识别超时（30 分钟）'));
      }, 30 * 60 * 1000);
      this.pending.set(id, { resolve, reject, out: outPath, timer });
      try {
        this.proc.stdin.write(JSON.stringify({
          cmd: 'transcribe', id, audio: job.audio, tta: job.tta,
        }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('写入常驻进程失败：' + e.message));
      }
    });
  }

  stop() {
    if (!this.proc) return;
    try { this.proc.stdin.write('{"cmd":"quit"}\n'); } catch {}
    const p = this.proc;
    setTimeout(() => { try { p.kill(); } catch {} }, 2000).unref?.();
    this.proc = null;
    this.ready = false;
  }
}

export class AsrService {
  constructor(opts) {
    this.python = opts.python;
    this.onLog = opts.onLog || (() => {});
    this.workers = new Map();
  }

  setPython(py) { this.python = py; }

  /**
   * 跑一次识别，把结果 JSON 写到 outPath（与原有 CLI 契约保持一致，调用方不用改）。
   * 失败时抛错，调用方可以退回原来的 spawn 路径。
   */
  async transcribe({ script, model, provider, extra, audio, tta, outPath, language }) {
    const key = serviceKey(script, model, provider);
    let w = this.workers.get(key);
    if (!w) {
      w = new Worker({ key, python: this.python, script, model, provider, extra, onLog: this.onLog });
      this.workers.set(key, w);
    }
    if (w.idleTimer) { clearTimeout(w.idleTimer); w.idleTimer = null; }
    w.start();
    try {
      await w.waitReady();
      const res = await w.transcribe({ audio, tta }, outPath);
      const payload = {
        duration: res.duration, language: res.language || language || 'en',
        segments: res.segments || [],
      };
      if (res.confidence) payload.confidence = res.confidence;
      const tmp = outPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, outPath);
      this._scheduleIdle(key, w);
      return payload;
    } catch (e) {
      // 失败路径同样布置空闲回收: 否则最后一次调用失败（超时/进程退出）后没人再
      // 清 timer，worker 进程与 Map 条目永驻内存。短暂失败后 5 分钟内重试仍复用进程。
      this._scheduleIdle(key, w);
      throw e;
    }
  }

  /** 空闲超时收掉：模型可能占几 GB 内存，不该一直挂着 */
  _scheduleIdle(key, w) {
    if (w.idleTimer) clearTimeout(w.idleTimer);
    w.idleTimer = setTimeout(() => {
      this.onLog('[asr-serve] 空闲超时，关闭常驻识别进程释放内存');
      w.stop();
      this.workers.delete(key);
    }, IDLE_MS);
    w.idleTimer.unref?.();
  }

  stopAll() {
    for (const [, w] of this.workers) w.stop();
    this.workers.clear();
  }

  /** 当前常驻了哪些引擎（状态页/日志用）。 */
  status() {
    return [...this.workers.values()].map((w) => ({
      key: w.key, ready: w.ready, running: !!w.proc, pending: w.pending.size,
    }));
  }
}
