import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = path.join(root, 'tools/templates/studio.html');
const target = path.join(root, 'editor/studio.html');
try { fs.writeFileSync(target, String(fs.readFileSync(template))); } catch (error) { if (error.code === 'ENOENT') throw new Error('Missing Studio template: ' + template); throw error; }
for (const [src, dest] of [['themes.js', 'studio-themes.js'], ['progress.js', 'studio-progress.js']]) {
  const source = path.join(root, 'prototypes/subfabric-ui', src);
  try { fs.copyFileSync(source, path.join(root, 'editor/js', dest)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
console.log('Studio entry generated from its standalone template.');

