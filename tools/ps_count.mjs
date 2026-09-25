// node 内调 tasklist 的 EBUSY 问题: 用异步 spawn 代替 spawnSync (server.js 里也踩过同样的坑)
import { spawn } from 'node:child_process';
const p = spawn('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true });
let out = '';
p.stdout.on('data', d => out += d);
p.on('error', e => { console.log('error:', e.message); process.exit(1); });
p.on('close', () => {
  const lines = out.split('\n').filter(l => /powershell\.exe/i.test(l));
  console.log('powershell 进程数:', lines.length);
  lines.slice(0, 6).forEach(l => console.log(l.trim().slice(0, 130)));
  process.exit(0);
});
