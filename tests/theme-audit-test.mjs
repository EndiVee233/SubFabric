import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { inventory, literalErrors, requiredTokens, undefinedReferences, visualLiterals } from '../tools/lib/theme-audit.mjs';

const root = path.resolve(import.meta.dirname, '..');
const current = inventory(root);
assert.equal(fs.readFileSync(path.join(root,'tools/templates/studio.html'),'utf8'),fs.readFileSync(path.join(root,'editor/studio.html'),'utf8'),'generated Studio entry matches its upstream template');
const saved = JSON.parse(fs.readFileSync(path.join(root, 'docs/theme-ui-coverage.json'), 'utf8'));
assert.deepEqual(current, saved, 'production UI changed: run node tools/theme-audit.mjs and review the new inventory/rendering scope');
const policy = JSON.parse(fs.readFileSync(path.join(root, 'docs/theme-literal-exceptions.json'), 'utf8'));
for (const file of policy.files) for (const entry of file.literals) assert.ok(entry.reason && entry.count > 0, 'exceptions require a reason and finite count');
assert.deepEqual(literalErrors(current, policy), [], 'new visual literals require a reviewed semantic/asset exception');
const source = fs.readFileSync(path.join(root, 'editor/js/studio-themes.js'), 'utf8');
const properties = new Map();
const context = {window:{},document:{body:{dataset:{},style:{setProperty(k,v){properties.set(k,v);},removeProperty(k){properties.delete(k);}}}}};
vm.runInNewContext(source, context);
const themes = context.window.SF_THEMES;
assert.equal(fs.readdirSync(path.join(root,'editor/themes')).filter(f=>f.endsWith('.theme.json')).length,themes.builtins.length);
for (const pack of themes.builtins) for (const dark of [false,true]) {
  const palette = themes.palette(pack.seed,dark);
  assert.equal(themes.valid({...pack,tokens:{light:{text:'rgb(0,0,0)'}}}),false,'invalid imported token format is rejected');
  for (const token of requiredTokens) assert.match(palette[token], /^#[\da-f]{6}$/i, `${pack.id} ${dark} ${token}`);
  // Switching through every design must replace the same mandatory token set.
  themes.apply({themePack:pack.id,accent:pack.seed},[],dark);
  for(const token of requiredTokens) assert.ok(properties.get(token), `${pack.id}: missing ${token}`);
  for(const token of ['--success','--warning','--danger','--info']) {
    const surfaces = dark ? ['#1E1B19','#2B2B2B','#35322A'] : ['#FFFFFF','#E5E5E5','#EFECE3'];
    for(const bg of surfaces) assert.ok(themes.contrast(properties.get(token),bg)>=4.5, `${pack.id} ${token} on ${bg}`);
  }
}
const sources = current.files.filter(f=>/\.(?:css|js|html)$/.test(f.file)).map(f=>fs.readFileSync(path.join(root,f.file),'utf8'));
assert.deepEqual(undefinedReferences(sources), [], 'CSS variables without fallback need a static or runtime definition');
// Negative controls prove the guards fail for realistic additions, in memory only.
for (const [kind,text] of [['.css','.new {color:#f00}'],['.html','<span style="background:#ff0000">x</span>'],['.js',"hint.style.color='#ff0000'"],['.js','const icon=`<svg fill="#ff0000"></svg>`']]) {
  assert.ok(visualLiterals(text,kind).length, `detect ${kind} raw UI color`);
  assert.ok(literalErrors({files:[{file:'new'+kind,literals:visualLiterals(text,kind)}]},policy).length);
}
assert.deepEqual(visualLiterals('/* color:#f00 */ .safe { color:var(--text); fill:currentColor }','.css'),[]);
assert.deepEqual(undefinedReferences(['.new{color:var(--missing-theme-token)}']),['--missing-theme-token']);
assert.deepEqual(undefinedReferences(['.new{color:var(--optional, currentColor)}']),[]);
const broken = source.replace("'--surface-3': tone(h, n, dark ? 23 : 87),",'');
assert.notEqual(broken,source);
const other={window:{}}; vm.runInNewContext(broken,other);
assert.equal(other.window.SF_THEMES.palette('#0078D7',false)['--surface-3'],undefined,'negative control detects missing palette role');
console.log(`Theme audit: ${themes.builtins.length} packs × 2 modes; inventory, token references, literal budgets and negative controls passed`);
