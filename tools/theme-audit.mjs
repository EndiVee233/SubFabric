/* Refresh discovery only. Literal exceptions are intentionally edited/reviewed separately. */
import fs from 'node:fs';
import path from 'node:path';
import { inventory } from './lib/theme-audit.mjs';
const root = path.resolve(import.meta.dirname, '..');
const data = inventory(root);
fs.writeFileSync(path.join(root, 'docs/theme-ui-coverage.json'), JSON.stringify(data, null, 2) + '\n');
console.log(`UI inventory: ${data.files.length} files, ${data.files.reduce((n,f)=>n+f.ids.length,0)} DOM ids, ${data.files.reduce((n,f)=>n+f.dynamic.length,0)} dynamic sites`);
