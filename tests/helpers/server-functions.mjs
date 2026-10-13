import fs from 'node:fs';
import vm from 'node:vm';
// 执行生产函数本体；仅取函数声明边界，断言全部针对运行行为。
export function serverFunctions(names, globals = {}) {
  const source = fs.readFileSync(new URL('../../editor/server.js', import.meta.url), 'utf8');
  const functions = names.map(name => {
    const pattern = new RegExp('^([ \\t]*)(?:async )?function ' + name + '\\([^\\n]*\\n[\\s\\S]*?^\\1}', 'm');
    const match = pattern.exec(source); if (!match) throw Error('Missing production function: ' + name); return match[0];
  });
  const ctx = vm.createContext({ Buffer, console, ...globals });
  vm.runInContext(functions.join('\n') + '\n globalThis.functions = {' + names.join(',') + '};', ctx);
  return ctx.functions;
}
