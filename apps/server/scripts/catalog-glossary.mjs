import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const glossaryDir = join(dirname(fileURLToPath(import.meta.url)), 'catalog-glossary');

function pairs(file) {
  const rows = [];
  for (const line of readFileSync(join(glossaryDir, file), 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const tab = trimmed.indexOf('|');
    if (tab < 0) throw new Error(`bad glossary line: ${trimmed}`);
    rows.push([trimmed.slice(0, tab).trim(), trimmed.slice(tab + 1).trim()]);
  }
  return rows;
}

const DROP = new Set([
  'a',
  'an',
  'the',
  'of',
  'and',
  'or',
  'to',
  'from',
  'with',
  'on',
  'in',
  'for',
  'at',
  'by',
  'into',
  'onto',
  'while',
  'than',
  'as',
  'if',
  'per',
  'via',
  'about',
  'vs',
  'versus',
  'your',
  'you',
]);

const PHRASES = pairs('phrases.txt').map(([en, zh]) => ({
  en,
  zh,
  parts: en.split(' ').filter(Boolean),
}));
const byFirst = new Map();
for (const entry of PHRASES) {
  const list = byFirst.get(entry.parts[0]) ?? [];
  list.push(entry);
  byFirst.set(entry.parts[0], list);
}
for (const list of byFirst.values()) list.sort((a, b) => b.parts.length - a.parts.length);

export const WORDS = new Map(pairs('words.txt'));

export const NAME_LOCKS = {
  '0025': { name: '杠铃卧推', aliases: ['卧推'] },
  '0032': { name: '杠铃硬拉', aliases: ['硬拉'] },
  '0043': { name: '杠铃深蹲', aliases: ['深蹲'] },
  '0501': { name: '波比跳', aliases: ['伯皮'] },
  '0652': { name: '引体向上', aliases: ['引体'] },
  '0662': { name: '俯卧撑', aliases: [] },
  1160: { name: '波比跳', aliases: ['伯皮'] },
  1197: { name: '徒手深蹲', aliases: ['深蹲'] },
  3094: { name: '开合跳', aliases: [] },
};

const WRAP = [
  '稳定球',
  'BOSU球',
  '片式配重',
  '变式二',
  '变式三',
  '变式四',
  '正面',
  '侧面',
  '背面',
  '男士',
  '女士',
];

export function normalizeExerciseName(name) {
  return name
    .toLowerCase()
    .replaceAll('в°', '°')
    .replaceAll('3/4', 'three quarter')
    .replaceAll('v.', 'v')
    .replaceAll('-', ' ')
    .replaceAll("'", '')
    .replaceAll('/', ' ')
    .replace(/[().,+]/g, ' ')
    .replace(/[^a-z0-9°\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function translateExerciseName(name) {
  const tokens = normalizeExerciseName(name).split(' ').filter(Boolean);
  const out = [];
  const unknown = [];
  let index = 0;
  while (index < tokens.length) {
    const options = byFirst.get(tokens[index]) ?? [];
    let best = null;
    for (const entry of options) {
      if (entry.parts.length > tokens.length - index) continue;
      let matches = true;
      for (let offset = 0; offset < entry.parts.length; offset += 1) {
        if (tokens[index + offset] !== entry.parts[offset]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        best = entry;
        break;
      }
    }
    if (best) {
      if (best.zh) out.push(best.zh);
      index += best.parts.length;
      continue;
    }
    const word = tokens[index];
    index += 1;
    if (DROP.has(word)) continue;
    if (/^\d+$/.test(word)) {
      out.push(word);
      continue;
    }
    if (word.endsWith('°')) {
      out.push(`${word.slice(0, -1)}度`);
      continue;
    }
    if (WORDS.has(word)) {
      const zh = WORDS.get(word);
      if (zh) out.push(zh);
      continue;
    }
    unknown.push(word);
    out.push(word);
  }
  let text = out.join('').replace(/(杠铃|哑铃|绳索|壶铃|弹力带|阻力带)\1+/g, '$1');
  text = text.replace(/式式/g, '式');
  text = text.replace(/^(.*\D)(\d+度)$/, '$1（$2）');
  for (const suffix of WRAP) {
    if (text.endsWith(suffix) && text.length > suffix.length + 1) {
      text = `${text.slice(0, -suffix.length)}（${suffix}）`;
      break;
    }
  }
  return { name: text, unknown };
}
