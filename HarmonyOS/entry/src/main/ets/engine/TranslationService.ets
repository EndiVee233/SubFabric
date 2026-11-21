/*
 * TranslationService —— 修正 ArkTS 对象字面量违规后的完整文件。
 *
 * ArkTS 有两条比 TypeScript 更严的限制：
 *   arkts-no-untyped-obj-literals    对象字面量必须对应显式声明的 class/interface
 *   arkts-no-noninferrable-arr-literals 数组元素类型必须可推断
 * 因此请求体与响应解析都改成用 interface 描述、显式构造。
 */

import { http } from '@kit.NetworkKit';
import { Logger } from './Logger';
import {
  GlossaryEntry, GlossaryGroup, glossaryForTarget, providerDefaults
} from './TranslationScheme';
import type { ITranslator } from 'common';

const TAG = 'Translate';

/** 语言代码 -> 供提示词使用的可读名。 */
const LANG_NAMES: Record<string, string> = {
  'zh': '简体中文',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  'en': 'English',
  'ja': '日本語',
  'ko': '한국어',
  'fr': 'Français',
  'de': 'Deutsch',
  'es': 'Español',
  'ru': 'Русский',
  'pt': 'Português',
  'it': 'Italiano'
};

/** 一条对话消息。 */
interface ChatMessage {
  role: string;
  content: string;
}

/** OpenAI 兼容的 /chat/completions 请求体。 */
interface ChatRequest {
  model: string;
  temperature: number;
  messages: ChatMessage[];
}

/** 响应里的 message。 */
interface ChatResponseMessage {
  content?: string;
}

/** 响应里的 choice。 */
interface ChatResponseChoice {
  message?: ChatResponseMessage;
}

/** 响应顶层（只声明用得到的字段）。 */
interface ChatResponse {
  choices?: ChatResponseChoice[];
}

/** Anthropic Messages API。 */
interface AnthropicRequest {
  model: string;
  max_tokens: number;
  temperature: number;
  system: string;
  messages: ChatMessage[];
}

interface AnthropicContent {
  type?: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicContent[];
}

/** 可控的翻译参数。 */
export class TranslateOptions {
  provider: string = 'deepseek';
  temperature: number = 0.2;
  /** 单次请求最多带多少行字幕。 */
  batchSize: number = 20;
  /** 单行最长字符数（超出会被截断，避免超模型上下文）。 */
  maxCharsPerLine: number = 400;
  timeoutMs: number = 60000;
  /** 自定义 LLM 提示词；留空使用内置字幕翻译提示。 */
  prompt: string = '';
  /** 按目标语言分组的术语表。 */
  glossary: GlossaryGroup[] = [];
}

export class TranslationService implements ITranslator {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly provider: string;
  private readonly options: TranslateOptions;
  /** 最近一次失败原因，供设置页展示。 */
  lastError: string = '';

  constructor(endpoint: string, apiKey: string, model: string,
              options: TranslateOptions = new TranslateOptions()) {
    this.provider = options.provider;
    const fallback = providerDefaults(this.provider);
    this.endpoint = endpoint.trim().length > 0 ? endpoint.trim() : fallback.endpoint;
    this.apiKey = apiKey.trim();
    this.model = model.trim().length > 0 ? model.trim() : fallback.model;
    this.options = options;
  }

  backendName(): string {
    return this.endpoint.length > 0 ? `在线翻译（${this.model}）` : '未配置';
  }

  async isReady(): Promise<boolean> {
    return this.endpoint.length > 0 && this.apiKey.length > 0;
  }

  /** 设置页「测试连接」：发一条最小请求，返回模型回复摘要。 */
  async testConnection(): Promise<string> {
    if (this.apiKey.length === 0) {
      throw new Error('请先填写 API Key');
    }
    if (this.endpoint.length === 0) {
      throw new Error('请填写 API 接口地址，或选择有默认地址的服务商');
    }
    const system = this.systemPrompt();
    const user = '请只回复 OK，用于测试连接。';
    let raw = '';
    if (this.provider === 'anthropic') {
      const request: AnthropicRequest = {
        model: this.model,
        max_tokens: 32,
        temperature: 0,
        system: system,
        messages: [{ role: 'user', content: user }]
      };
      raw = await this.postAnthropic(JSON.stringify(request));
    } else {
      const request: ChatRequest = {
        model: this.model,
        temperature: 0,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
      };
      raw = await this.post(JSON.stringify(request));
    }
    return clip(raw.trim(), 120);
  }

  /** 把批量文本翻成目标语言。 */
  async translate(texts: string[], sourceLang: string, targetLang: string,
                  context?: string): Promise<string[]> {
    if (texts.length === 0) {
      return [];
    }
    if (this.endpoint.length === 0) {
      throw new Error('未配置翻译服务地址');
    }
    const out: string[] = [];
    // 分批请求，批内一次完成。
    for (let start = 0; start < texts.length; start += this.options.batchSize) {
      const end = Math.min(texts.length, start + this.options.batchSize);
      const batch: string[] = [];
      for (let i = start; i < end; i++) {
        batch.push(clip(texts[i], this.options.maxCharsPerLine));
      }
      const translated = await this.translateBatch(batch, sourceLang, targetLang,
        start === 0 ? context : undefined);
      for (let i = 0; i < translated.length; i++) {
        out.push(translated[i]);
      }
    }
    return out;
  }

  /** 翻译一批（行数敏感，行数不匹配就报错）。 */
  private async translateBatch(lines: string[], sourceLang: string,
                               targetLang: string,
                               context?: string): Promise<string[]> {
    const srcName = LANG_NAMES[sourceLang] ?? sourceLang;
    const tgtName = LANG_NAMES[targetLang] ?? targetLang;

    // 用编号列表输入输出，便于校验行数与顺序。
    const numbered: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      numbered.push(`${i + 1}. ${lines[i]}`);
    }
    let user = '';
    if (context !== undefined && context.length > 0) {
      user += `上文（仅供理解语境，不要翻译这段）：\n${clip(context, 400)}\n\n`;
    }
    const glossary = this.glossaryText(targetLang);
    if (glossary.length > 0) {
      user += `术语表（必须使用以下译法）：\n${glossary}\n\n`;
    }
    user += `把下面每一条字幕从${srcName}翻译成${tgtName}。\n`
      + `要求：\n`
      + `- 严格保持行数与编号一一对应，不要合并或拆分任何一条；\n`
      + `- 只输出 "编号. 译文"，不要输出原文，也不要加任何解释；\n`
      + `- 译文要口语化、适合作为视频字幕，长度尽量贴近原文；\n`
      + `- 术语表里的词条必须按给定译法输出。\n\n`
      + `${numbered.join('\n')}`;

    const systemText = this.systemPrompt();
    let raw = '';
    if (this.provider === 'anthropic') {
      const request: AnthropicRequest = {
        model: this.model,
        max_tokens: 8192,
        temperature: this.options.temperature,
        system: systemText,
        messages: [{ role: 'user', content: user }]
      };
      raw = await this.postAnthropic(JSON.stringify(request));
    } else {
      const messages: ChatMessage[] = [
        { role: 'system', content: systemText },
        { role: 'user', content: user }
      ];
      const request: ChatRequest = {
        model: this.model,
        temperature: this.options.temperature,
        messages: messages
      };
      raw = await this.post(JSON.stringify(request));
    }
    const parsed = parseNumbered(raw, lines.length);
    if (parsed === null) {
      // 退化：直接按行拆分，行数对上就用。
      const byLine: string[] = [];
      const rawLines = raw.split('\n');
      for (let i = 0; i < rawLines.length; i++) {
        const s = stripNumber(rawLines[i].trim());
        if (s.length > 0) {
          byLine.push(s);
        }
      }
      if (byLine.length === lines.length) {
        return byLine;
      }
      this.lastError = `返回行数不匹配（期望 ${lines.length}，得到 ${byLine.length}）`;
      throw new Error(this.lastError);
    }
    return parsed;
  }

  private systemPrompt(): string {
    const custom = this.options.prompt.trim();
    if (custom.length > 0) {
      return custom;
    }
    return '你是一名专业的视频字幕翻译，只输出译文列表。';
  }

  private glossaryText(targetLang: string): string {
    const entries: GlossaryEntry[] = glossaryForTarget(this.options.glossary, targetLang);
    const lines: string[] = [];
    let chars = 0;
    for (let i = 0; i < entries.length && i < 200; i++) {
      const e = entries[i];
      const line = `${e.term} -> ${e.translation}`;
      if (chars + line.length > 4000) {
        break;
      }
      lines.push(line);
      chars += line.length + 1;
    }
    return lines.join('\n');
  }

  private openAiHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`
    };
  }

  private anthropicHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01'
    };
  }

  private async send(url: string, body: string,
                     headers: Record<string, string>): Promise<string> {
    const request = http.createHttp();
    try {
      const resp = await request.request(url, {
        method: http.RequestMethod.POST,
        header: headers,
        extraData: body,
        connectTimeout: this.options.timeoutMs,
        readTimeout: this.options.timeoutMs,
        expectDataType: http.HttpDataType.STRING
      });
      if (resp.responseCode !== 200) {
        const text = typeof resp.result === 'string' ? resp.result : '';
        this.lastError = `HTTP ${resp.responseCode}：${clip(text, 200)}`;
        throw new Error(this.lastError);
      }
      return typeof resp.result === 'string' ? resp.result : '';
    } catch (err) {
      const e = err as Error;
      if (this.lastError.length === 0) {
        this.lastError = e.message;
      }
      Logger.error(TAG, `翻译请求失败：${e.message}`);
      throw new Error(`翻译请求失败：${e.message}`);
    } finally {
      request.destroy();
    }
  }

  /** 发出 OpenAI 兼容请求并返回助手回复文本。 */
  private async post(body: string): Promise<string> {
    const payload = await this.send(this.normalizeUrl(), body, this.openAiHeaders());
    return extractContent(payload);
  }

  /** Anthropic Messages API 请求。 */
  private async postAnthropic(body: string): Promise<string> {
    const payload = await this.send(this.normalizeUrl(), body, this.anthropicHeaders());
    return extractAnthropicContent(payload);
  }

  /** 补齐 /chat/completions 或 Anthropic /messages 路径。 */
  private normalizeUrl(): string {
    let url = this.endpoint;
    if (url.endsWith('/')) {
      url = url.substring(0, url.length - 1);
    }
    if (this.provider === 'anthropic') {
      if (url.endsWith('/messages')) {
        return url;
      }
      if (url.endsWith('/v1')) {
        return `${url}/messages`;
      }
      return `${url}/v1/messages`;
    }
    if (url.endsWith('/chat/completions')) {
      return url;
    }
    if (url.endsWith('/v1')) {
      return `${url}/chat/completions`;
    }
    return `${url}/v1/chat/completions`;
  }
}

/** 从 OpenAI 风格响应里取 choices[0].message.content。 */
function extractContent(payload: string): string {
  let resp: ChatResponse;
  try {
    resp = JSON.parse(payload) as ChatResponse;
  } catch (err) {
    const e = err as Error;
    throw new Error(`无法解析翻译响应：${e.message}`);
  }
  const choices = resp.choices;
  if (choices === undefined || choices.length === 0) {
    throw new Error('响应里没有 choices');
  }
  const message = choices[0].message;
  if (message === undefined) {
    throw new Error('响应里没有 message');
  }
  return message.content ?? '';
}

/** 从 Anthropic 响应里取 content[].text。 */
function extractAnthropicContent(payload: string): string {
  let resp: AnthropicResponse;
  try {
    resp = JSON.parse(payload) as AnthropicResponse;
  } catch (err) {
    const e = err as Error;
    throw new Error(`无法解析 Anthropic 响应：${e.message}`);
  }
  const content = resp.content;
  if (content === undefined || content.length === 0) {
    throw new Error('Anthropic 响应里没有 content');
  }
  const parts: string[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i].type === undefined || content[i].type === 'text') {
      parts.push(content[i].text ?? '');
    }
  }
  return parts.join('\n');
}

/** 解析 "1. xxx" 形式的结果，行数必须一致。 */
function parseNumbered(text: string, expected: number): string[] | null {
  const lines = text.split('\n');
  const map = new Map<number, string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) {
      continue;
    }
    const m = /^(\d+)\s*[.、:：)]\s*(.*)$/.exec(line);
    if (m === null) {
      continue;
    }
    const idx = Number.parseInt(m[1], 10);
    const body = m[2].trim();
    if (idx >= 1 && idx <= expected && body.length > 0) {
      map.set(idx, body);
    }
  }
  if (map.size !== expected) {
    return null;
  }
  const out: string[] = [];
  for (let i = 1; i <= expected; i++) {
    const v = map.get(i);
    if (v === undefined) {
      return null;
    }
    out.push(v);
  }
  return out;
}

function stripNumber(line: string): string {
  const m = /^(\d+)\s*[.、:：)]\s*(.*)$/.exec(line);
  return m === null ? line : m[2].trim();
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.substring(0, n)}…`;
}
