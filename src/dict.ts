import type { TtsResult } from '@bob-translate/types';
import type { Addition, DictObject, Exchange, Part, Phonetic } from './types';

// 有道发音接口：type 2 美音、1 英音
function youdaoTts(word: string, type: 'us' | 'uk'): TtsResult {
  return {
    type: 'url',
    value: `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${type === 'us' ? 2 : 1}`,
  };
}

// 字段标签别名表：模型偶尔用中文标签或全角冒号写行头，统一归一到标准标签。
// 只归一「标签部分」，值内容不动（例句译文里的中文冒号必须原样保留）。
const TAG_ALIASES: Record<string, string> = {
  单词: 'WORD',
  词: 'WORD',
  美: 'US',
  美式: 'US',
  美音: 'US',
  美式音标: 'US',
  音标: 'US',
  英: 'UK',
  英式: 'UK',
  英音: 'UK',
  英式音标: 'UK',
  词性: 'POS',
  变形: 'FORM',
  例句: 'EX',
  记忆: 'NOTE',
  记忆提示: 'NOTE',
  又译: 'ALT',
  其他译法: 'ALT',
};

// 行头归一化：剥掉 markdown 加粗/代码标记，全角冒号转半角（仅首个分隔符），中文标签映射。
// 返回 [tag, value]；不是「标签: 值」结构时 tag 为空串。
function splitTagLine(line: string): [string, string] {
  // 半角冒号在前用半角，否则用全角：避免「US：跑：义」这类值里带冒号时切错位置
  const half = line.indexOf(':');
  const full = line.indexOf('：');
  const idx = half !== -1 && (full === -1 || half < full) ? half : full;
  if (idx === -1) return ['', ''];
  let tag = line
    .slice(0, idx)
    .replace(/[*`#[\]]/g, '')
    .trim()
    .toUpperCase();
  tag = TAG_ALIASES[tag] || tag;
  return [tag, line.slice(idx + 1).trim()];
}

// IPA 特征字符：判断「/.../」里是音标而不是普通斜杠文本
const IPA_CHARS = /[ˈˌːæɑɒɔəɛɜɪʊʌʃʒθðŋɹɻɝɚɫçɸβɛ]/;

// 从 WORD 行的值里剥离内联音标（模型常写「WORD: super /ˈsuːpər/」），返回 [纯词, 音标或空]
function extractInlinePhonetic(val: string): [string, string] {
  const m = /\/([^/]+)\//.exec(val);
  const ipa = m?.[1]?.trim();
  if (m && ipa && IPA_CHARS.test(ipa)) {
    const word = val.replace(m[0], '').trim();
    if (word) return [word, ipa];
  }
  return [val, ''];
}

// 单词/短语判定：≤3 个拉丁词（允许连字符、撇号）
export function isDictQuery(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 60) return false;
  const words = t.split(/\s+/);
  if (words.length > 3) return false;
  return /^[A-Za-z][A-Za-z\-'’]*(\s+[A-Za-z][A-Za-z\-'’]*)*$/.test(t);
}

// 中文词典候选门：宽松初筛，全汉字且 ≤10 字（成语/专业词进得来，长句进不来）。
// 是词还是短句由模型终判：词吐字段格式，句吐纯译文（解析失败自动落段落展示）。
export function isCjkDictQuery(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 10) return false;
  return /^\p{Script=Han}+$/u.test(t);
}

export function stripSlashes(s: string): string {
  return (s || '').replace(/^\/+|\/+$/g, '').trim();
}

// 紧凑行格式 → toDict；无词性词义时返回 null，由调用方兜底。
export function parseDictText(text: string, queryText: string): DictObject | null {
  let word = queryText;
  const phonetics: Phonetic[] = [];
  const parts: Part[] = [];
  const exchanges: Exchange[] = [];
  const additions: Addition[] = [];

  for (const raw of (text || '').split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) continue;
    const [tag, val] = splitTagLine(line);
    if (!tag || !val) continue;

    switch (tag) {
      case 'WORD': {
        // 模型可能把音标内联在词后（WORD: super /ˈsuːpər/），拆出来补进 phonetics。
        // 内联音标不分美英、按美音处理；已有显式 US 行时不覆盖
        const [w, ipa] = extractInlinePhonetic(val);
        word = w;
        if (ipa && !phonetics.some((p) => p.type === 'us')) {
          phonetics.push({ type: 'us', value: stripSlashes(ipa) });
        }
        break;
      }
      case 'US':
      case 'UK': {
        const type = tag === 'US' ? 'us' : 'uk';
        // 内联音标已占位同类型时不重复追加，以显式 US/UK 行优先覆盖
        const existing = phonetics.find((p) => p.type === type);
        if (existing) existing.value = stripSlashes(val);
        else phonetics.push({ type, value: stripSlashes(val) });
        break;
      }
      case 'POS': {
        const pi = val.indexOf('|');
        const part = pi === -1 ? '' : val.slice(0, pi).trim();
        const meansStr = pi === -1 ? val : val.slice(pi + 1);
        const means = meansStr
          .split(/[;；]/)
          .map((m) => m.trim())
          .filter((m) => m);
        if (means.length) parts.push({ part, means });
        break;
      }
      case 'FORM': {
        const ei = val.indexOf('=');
        if (ei === -1) break;
        const name = val.slice(0, ei).trim();
        const words = val
          .slice(ei + 1)
          .split(/[,，、]/)
          .map((w) => w.trim())
          .filter((w) => w);
        if (name && words.length) exchanges.push({ name, words });
        break;
      }
      case 'EX': {
        const xi = val.indexOf('|');
        const value = xi === -1 ? val : `${val.slice(0, xi).trim()}\n${val.slice(xi + 1).trim()}`;
        additions.push({ name: '例句', value });
        break;
      }
      case 'NOTE':
        additions.push({ name: '记忆提示', value: val });
        break;
      case 'ALT':
        additions.push({ name: '其他译法', value: val });
        break;
      default:
        break;
    }
  }

  if (!parts.length) return null;
  // 循环后才挂 tts：WORD 行可能改写原词
  for (const p of phonetics) {
    p.tts = youdaoTts(word, p.type);
  }
  // ToDictObject 要求 phonetics 必填，为空也要带上
  const dict: DictObject = { word, parts, phonetics };
  if (exchanges.length) dict.exchanges = exchanges;
  if (additions.length) dict.additions = additions;
  return dict;
}

// 流式预览 / 解析失败兜底：紧凑行格式 → 易读段落。
// 与 parseDictText 共用 splitTagLine 归一化，保证预览和最终卡片对同一行判定一致。
export function dictPreviewParagraphs(text: string): string[] {
  const out: string[] = [];
  for (const raw of (text || '').split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) continue;
    const [tag, val] = splitTagLine(line);
    if (!tag || !val) {
      // 无冒号或空值行是正文（如模型判为句子后输出的纯译文），保留整行
      out.push(line);
      continue;
    }
    switch (tag) {
      case 'WORD': {
        const [w, ipa] = extractInlinePhonetic(val);
        out.push(ipa ? `${w} /${stripSlashes(ipa)}/` : val);
        break;
      }
      case 'US':
        out.push(`美 /${stripSlashes(val)}/`);
        break;
      case 'UK':
        out.push(`英 /${stripSlashes(val)}/`);
        break;
      case 'POS':
        out.push(val.replace('|', ' ').trim());
        break;
      case 'FORM':
        out.push(val.replace('=', '：').trim());
        break;
      case 'EX':
        out.push(val.replace('|', ' — ').trim());
        break;
      case 'NOTE':
        out.push(`💡 ${val}`);
        break;
      case 'ALT':
        out.push(`又译 ${val}`);
        break;
      default:
        // 非已知标签的冒号行是正文（如模型判为句子后输出的纯译文），保留整行
        out.push(line);
    }
  }
  return out.length ? out : [text || ''];
}

export function textToParagraphs(text: string): string[] {
  const paragraphs = (text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line);
  return paragraphs.length ? paragraphs : [text || ''];
}
