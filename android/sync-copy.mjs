import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const dictionaryPath = path.join(root, '../editor/lang/zh-CN.json');
const dictionary = JSON.parse(fs.readFileSync(dictionaryPath, 'utf8'));
const found = new Set();
function add(value) {
  value = value.trim().replace(/\$\{[^}]*\}/g, '◇');
  if (/[\u4e00-\u9fa5]/u.test(value)) found.add(value);
}
const assets=path.join(root,'app/src/main/assets');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.relative(assets,path.join(dir,entry.name))]);}
for (const file of walk(assets)) {
  if (!/\.(?:html|js)$/.test(file)) continue;
  const text = fs.readFileSync(path.join(root, 'app/src/main/assets', file), 'utf8');
  if (file.endsWith('.html')) {
    for (const match of text.matchAll(/>([^<>]+)</g)) add(match[1]);
    for (const match of text.matchAll(/(?:aria-label|placeholder|title)="([^"]+)"/g)) add(match[1]);
  } else {
    for (const match of text.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g)) add(match[2]);
  }
}
for (const file of fs.readdirSync(path.join(root, 'app/src/main/java/com/subfabric/android'))) {
  const text = fs.readFileSync(path.join(root, 'app/src/main/java/com/subfabric/android', file), 'utf8');
  for (const match of text.matchAll(/"((?:\\.|[^"\\\r\n])*)"/g)) add(match[1]);
}
let count = 0;
for (const key of found) if (dictionary[key] == null) { dictionary[key] = key; count++; }
fs.writeFileSync(dictionaryPath, JSON.stringify(dictionary, null, 2) + '\n');
console.log(`Registered ${count} Android copy entries`);
