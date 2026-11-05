/* 安装/卸载数据边界：两条链路（SEA 用 Inno、Electron 用 NSIS）实现不同，约束一致 ——
   ① 覆盖安装沿用已有安装目录，不先清空它；
   ② 只删程序文件，数据目录（asr/models、projects、videos、.profile …）一个字节都不碰；
   ③ 卸载默认**全部保留**，要连数据一起清空必须显式 /DELETE-DATA；
   ④ 静默卸载不弹窗，也一律按保留处理。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const iss = fs.readFileSync(path.join(root, 'build/installer/SubFabric.iss'), 'utf8');
const nsh = fs.readFileSync(path.join(root, 'desktop/installer.nsh'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8'));

/* ── SEA 侧（Inno Setup） ─────────────────────────────────── */
assert.match(iss, /function DetectDir/, '覆盖安装要能认出已有安装目录');
assert.match(iss, /function HasMarkers/, '靠 SubFabric.exe / editor\\server.js 判定是不是本产品的目录');
assert.match(iss, /function InitializeUninstall\(\): Boolean;/, '卸载前提供数据保留选择');
assert.match(iss, /CreateCustomForm\(/, '卸载选项用模态窗体给出（Inno 卸载向导不支持追加页）');
assert.match(iss, /ParamStr\(I\), '\/DELETE-DATA'/, '静默卸载支持显式删除数据');
for (const name of ['KeepAsr', 'KeepProj', 'KeepCfg']) {
  assert.match(iss, new RegExp(name + '\\s*:=\\s*True'), '默认保留：' + name);
}
assert.match(iss, /if UninstallSilent then Exit/, '静默卸载不弹窗');

// [InstallDelete] 只允许列程序文件：一旦出现数据目录名，升级就会吃掉用户数据。
// 注释里会点名这些目录（说明"不碰它们"），所以先剥掉注释行再断言。
const installDelete = iss.split('[InstallDelete]')[1].split('\n[')[0]
  .split('\n').filter((line) => !/^\s*;/.test(line)).join('\n');
assert.doesNotMatch(installDelete, /projects|models|videos|\.profile|runtime-python/,
  '安装时不得删除用户数据');
assert.match(installDelete, /\{app\}\\\*\.dll/, '接管 Electron 目录时清它专有的 dll');

/* ── Electron 侧（NSIS） ──────────────────────────────────── */
assert.match(nsh, /!macro customInit/, 'Electron 侧安装前要处理已有目录');
assert.match(nsh, /!macro customRemoveFiles/, 'Electron 侧自己决定删哪些文件');
for (const name of ['SfKeepAsr', 'SfKeepProjects', 'SfKeepConfig']) {
  assert.match(nsh, new RegExp('StrCpy \\$' + name + ' "1"'), '默认保留：' + name);
}
assert.match(nsh, /GetOptions[\s\S]{0,80}\/DELETE-DATA/, '卸载支持显式删除数据');
assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false, 'Electron 默认不删 AppData');
assert.equal(pkg.build.nsis.include, 'installer.nsh', 'Electron 卸载自定义脚本已接入');

console.log('installer-data: 两版都默认保留数据、只删程序文件、/DELETE-DATA 才清空');
