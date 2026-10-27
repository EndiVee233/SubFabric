import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { jsLiterals } from './copy_scan.mjs';

export const requiredTokens = ['--bg', '--surface', '--surface-2', '--surface-3', '--text', '--muted', '--line', '--outline', '--accent', '--accent-soft', '--on-accent', '--success', '--warning', '--danger', '--info'];
const literal = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^;{}]*?\)|\b(?:white|black|red|green|blue|orange|yellow|pink|purple|gray|grey)\b/i;
const visual = '(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow|fill|stroke|accent-color|stop-color)';
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '));

export function uiFiles(root) {
  const walk = dir => fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(entry => entry.isDirectory()
    ? walk(dir+'/'+entry.name) : /\.(?:css|js|json)$/.test(entry.name) ? [dir+'/'+entry.name] : []);
  return ['tools/templates/studio.html', ...['editor/css', 'editor/js', 'editor/themes', 'editor/lang'].flatMap(walk)].sort();
}

// Declaration counts, rather than line numbers, survive formatting. New visual
// literals need a reviewed exception; removing an old one cannot authorize another.
export function visualLiterals(source, kind) {
  const found = [];
  const declarations = text => {
    for (const match of stripComments(text).matchAll(new RegExp('(?:^|[;{}"\'\\s])(' + visual + ')\\s*:\\s*([^;{}"\']+)', 'gi'))) {
      if (literal.test(match[2])) found.push(match[1].toLowerCase() + ':' + match[2].trim().replace(/\s+/g, ' '));
    }
    for (const match of text.matchAll(/\b(fill|stroke|stop-color)\s*=\s*["']([^"']+)["']/gi)) {
      if (literal.test(match[2])) found.push(match[1].toLowerCase() + ':' + match[2].trim());
    }
  };
  if (kind === '.js') {
    for (const { text } of jsLiterals(source, { hanOnly: false })) if (/<[a-z]|(?:color|background|shadow|fill|stroke)\s*:/i.test(text)) declarations(text);
    for (const match of stripComments(source).matchAll(/\.style\.(color|background(?:Color|Image)?|borderColor|boxShadow|fill|stroke)\s*=\s*(['"])([^'"\n]*)\2/g)) {
      if (literal.test(match[3])) found.push('style.' + match[1] + ':' + match[3]);
    }
    for (const match of stripComments(source).matchAll(/\.style\.setProperty\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g)) {
      if (!match[1].startsWith('--') && literal.test(match[2])) found.push('style.' + match[1] + ':' + match[2]);
    }
  } else if (kind === '.html') {
    const html = source.replace(/<!--[\s\S]*?-->/g, '');
    for (const match of html.matchAll(/\bstyle\s*=\s*"([^"]*)"/g)) declarations(match[1]);
    for (const match of html.matchAll(/\b(?:fill|stroke|stop-color)\s*=\s*["'][^"']+["']/g)) declarations(match[0]);
  } else if (kind === '.css') declarations(source);
  return found.sort();
}

export function inventory(root) {
  const files = uiFiles(root).map(file => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const literals = visualLiterals(text, path.extname(file));
    const ids = file.endsWith('.html') ? [...text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/\bid="([\w-]+)"/g)].map(m => m[1]).sort() : [];
    const dynamic = file.endsWith('.js') ? [...text.matchAll(/\b(innerHTML|insertAdjacentHTML|createElement|replaceChildren)\b/g)].map(m => ({ line: text.slice(0, m.index).split('\n').length, method: m[1] })) : [];
    const dynamicIds = file.endsWith('.js') ? [...new Set([
      ...jsLiterals(text,{hanOnly:false}).flatMap(({text:value})=>[...value.matchAll(/\bid=["']([^"']{1,120})["']/g)].map(m=>m[1])),
      ...text.matchAll(/\.id\s*=\s*['"]([\w-]+)['"]/g)
    ].map(value=>typeof value==='string'?value:value[1]))].sort() : [];
    return { file, sha256: createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex'), ids, dynamicIds, dynamic, literals };
  });
  const sources = files.filter(file=>/\.(?:css|js|html)$/.test(file.file)).map(file=>fs.readFileSync(path.join(root,file.file),'utf8'));
  return { schema: 1, scope: 'Static production UI inventory; rendering evidence is the separate browser matrix. Dynamic sites include helper calls and comments and need contextual review.', files, tokens: tokenInventory(sources) };
}

export function literalErrors(current, baseline) {
  const errors = [];
  for (const row of current.files) {
    const allowed = new Map((baseline.files.find(file => file.file === row.file)?.literals || []).map(entry => [entry.value, entry.count]));
    for (const value of row.literals) {
      const count = allowed.get(value) || 0;
      if (!count) errors.push(`${row.file}: unreviewed visual literal ${value}`);
      else allowed.set(value, count - 1);
    }
  }
  return errors;
}

export function tokenInventory(sources) {
  const all = sources.join('\n');
  const definitions = new Set([...all.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
  // JS setProperty/object keys may generate CSS tokens at runtime.
  for (const m of all.matchAll(/['"](--[\w-]+)['"]\s*:/g)) definitions.add(m[1]);
  for (const m of all.matchAll(/setProperty\(\s*['"](--[\w-]+)['"]\s*,/g)) definitions.add(m[1]);
  const referenced = new Set([...all.matchAll(/var\(\s*(--[\w-]+)/g)].map(m=>m[1]));
  const missing = [...new Set([...all.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map(m => m[1]).filter(name => !definitions.has(name)))].sort();
  return {defined:[...definitions].sort(),referenced:[...referenced].sort(),missing,unusedCandidates:[...definitions].filter(name=>!referenced.has(name)).sort()};
}
export const undefinedReferences = sources => tokenInventory(sources).missing;
