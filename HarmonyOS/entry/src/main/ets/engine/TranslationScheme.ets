/*
 * 翻译方案：服务商、模型、调用参数、术语表与提示词。
 *
 * 方案保存在应用沙箱的 translation-schemes.json；导出文件会去掉 API Key，
 * 避免把密钥带进可分享的 JSON。
 */

export class ProviderDefault {
  endpoint: string = '';
  model: string = '';

  constructor(endpoint: string = '', model: string = '') {
    this.endpoint = endpoint;
    this.model = model;
  }
}

export const TRANSLATION_PROVIDERS: string[] = ['deepseek', 'openai', 'anthropic', 'custom'];

export function providerLabel(provider: string): string {
  if (provider === 'openai') {
    return 'OpenAI';
  }
  if (provider === 'anthropic') {
    return 'Anthropic';
  }
  if (provider === 'custom') {
    return '自定义（OpenAI 兼容）';
  }
  return 'DeepSeek';
}

export function providerDefaults(provider: string): ProviderDefault {
  if (provider === 'openai') {
    return new ProviderDefault('https://api.openai.com/v1', 'gpt-4o-mini');
  }
  if (provider === 'anthropic') {
    return new ProviderDefault('https://api.anthropic.com/v1', 'claude-3-5-sonnet-latest');
  }
  if (provider === 'custom') {
    return new ProviderDefault('', '');
  }
  return new ProviderDefault('https://api.deepseek.com/v1', 'deepseek-chat');
}

/** 术语表中的一个词条。 */
export class GlossaryEntry {
  term: string = '';
  translation: string = '';

  constructor(term: string = '', translation: string = '') {
    this.term = term;
    this.translation = translation;
  }

  clone(): GlossaryEntry {
    return new GlossaryEntry(this.term, this.translation);
  }
}

/** 按目标语言分组的术语表。 */
export class GlossaryGroup {
  lang: string = 'zh';
  entries: GlossaryEntry[] = [];

  constructor(lang: string = 'zh', entries: GlossaryEntry[] = []) {
    this.lang = lang;
    this.entries = entries;
  }
}

export function glossaryLangLabel(lang: string): string {
  if (lang === 'zh-Hant') {
    return '繁體';
  }
  if (lang === 'en') {
    return 'English';
  }
  return '简体';
}

/** 复制一份术语表，避免设置页草稿直接改到 AppStore 的活动配置。 */
export function cloneGlossary(groups: GlossaryGroup[]): GlossaryGroup[] {
  const out: GlossaryGroup[] = [];
  for (let i = 0; i < groups.length; i++) {
    const entries: GlossaryEntry[] = [];
    for (let k = 0; k < groups[i].entries.length; k++) {
      entries.push(groups[i].entries[k].clone());
    }
    out.push(new GlossaryGroup(groups[i].lang, entries));
  }
  return out;
}

export function glossaryForTarget(groups: GlossaryGroup[], targetLang: string): GlossaryEntry[] {
  const lang = targetLang === 'zh-Hant' || targetLang === 'en' ? targetLang : 'zh';
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].lang === lang) {
      return groups[i].entries;
    }
  }
  return [];
}

/** 当前方案。 */
export class TranslationScheme {
  kind: string = 'subfabric.translation-scheme';
  version: number = 1;
  id: string = '';
  name: string = '';
  provider: string = 'deepseek';
  endpoint: string = '';
  apiKey: string = '';
  model: string = 'deepseek-chat';
  temperature: number = 0.2;
  batchSize: number = 20;
  contextLines: number = 1;
  prompt: string = '';
  autoTranslate: boolean = true;
  glossary: GlossaryGroup[] = [];

  toJson(includeKey: boolean): string {
    const copy = new TranslationScheme();
    copy.id = this.id;
    copy.name = this.name;
    copy.provider = this.provider;
    copy.endpoint = this.endpoint;
    copy.apiKey = includeKey ? this.apiKey : '';
    copy.model = this.model;
    copy.temperature = this.temperature;
    copy.batchSize = this.batchSize;
    copy.contextLines = this.contextLines;
    copy.prompt = this.prompt;
    copy.autoTranslate = this.autoTranslate;
    copy.glossary = cloneGlossary(this.glossary);
    return JSON.stringify(copy, null, 2);
  }
}

export class TranslationSchemeJson {
  kind?: string;
  version?: number;
  id?: string;
  name?: string;
  provider?: string;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  batchSize?: number;
  contextLines?: number;
  prompt?: string;
  autoTranslate?: boolean;
  glossary?: GlossaryJson[];
}

export class GlossaryJson {
  lang?: string;
  entries?: GlossaryEntryJson[];
}

export class GlossaryEntryJson {
  term?: string;
  translation?: string;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

export function parseTranslationScheme(text: string, keepKey: boolean = false): TranslationScheme {
  const raw = JSON.parse(text) as TranslationSchemeJson;
  const scheme = new TranslationScheme();
  scheme.id = raw.id ?? `scheme_${Date.now()}`;
  scheme.name = (raw.name ?? '').trim();
  scheme.provider = TRANSLATION_PROVIDERS.indexOf(raw.provider ?? '') >= 0
    ? (raw.provider as string) : 'deepseek';
  scheme.endpoint = (raw.endpoint ?? '').trim();
  scheme.apiKey = keepKey ? (raw.apiKey ?? '') : '';
  scheme.model = (raw.model ?? '').trim();
  scheme.temperature = clamp(Number(raw.temperature ?? 0.2), 0, 2, 0.2);
  scheme.batchSize = Math.round(clamp(Number(raw.batchSize ?? 20), 5, 100, 20));
  scheme.contextLines = Math.round(clamp(Number(raw.contextLines ?? 1), 0, 50, 1));
  scheme.prompt = raw.prompt ?? '';
  scheme.autoTranslate = raw.autoTranslate !== false;
  const groups: GlossaryGroup[] = [];
  if (Array.isArray(raw.glossary)) {
    for (let i = 0; i < raw.glossary.length; i++) {
      const group = raw.glossary[i];
      if (group === null || group === undefined) {
        continue;
      }
      const lang = group.lang === 'zh-Hant' || group.lang === 'en' ? group.lang : 'zh';
      const entries: GlossaryEntry[] = [];
      if (Array.isArray(group.entries)) {
        for (let k = 0; k < group.entries.length; k++) {
          const e = group.entries[k];
          if (e === null || e === undefined) {
            continue;
          }
          const term = (e.term ?? '').trim();
          const translation = (e.translation ?? '').trim();
          if (term.length > 0 && translation.length > 0) {
            entries.push(new GlossaryEntry(term, translation));
          }
        }
      }
      groups.push(new GlossaryGroup(lang, entries));
    }
  }
  scheme.glossary = groups;
  if (scheme.name.length === 0) {
    scheme.name = '未命名方案';
  }
  return scheme;
}
