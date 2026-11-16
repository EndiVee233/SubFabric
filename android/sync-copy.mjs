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
for(const message of ['支持 bilibili、YouTube 与可解析的媒体链接。下载保存在安卓本机，可关联已有字幕或新建 ASS 稿件。','Cookie 加密保存在安卓本机，界面不会回显。','安卓请导入浏览器导出的 Netscape Cookie 文件。'])add(message);
for(const message of ['仅删除选中的音频与波形缓存；重新打开稿件时从原媒体生成。字幕、原媒体、模型、任务与配置不会删除。','音频与波形缓存；原稿与原媒体保留','模型保留，不参与本页清理','应用组件与下载环境，均受保护','任务、字体与浏览器数据保留'])add(message);
for(const file of ['download.py','glossary-doc.mjs']){
  const source=fs.readFileSync(path.join(root,file),'utf8');
  for(const match of source.matchAll(/(['"])((?:\\.|(?!\1)[^\\\r\n])*)\1/g))add(match[2]);
}
for (const key of found) if (dictionary[key] == null) { dictionary[key] = key; count++; }
fs.writeFileSync(dictionaryPath, JSON.stringify(dictionary, null, 2) + '\n');
console.log(`Registered ${count} Android copy entries`);
