/* 波形诊断页渲染验证: 用无头浏览器实际加载 outputs/waveform-compare.html,
 * 沿每列量"从背景中轴往外延伸多远"的轮廓, 断言 c1 实心 / c2 c3 有起伏。
 * 跑法: node tools/wave_shot.mjs
 * 产出: outputs/wave-check.png + 退出码(0=断言全过)
 *
 * 关键: 不能只看 alpha —— 轨道底色本身不透明。要按"亮度"把波形像素从背景里分出来。
 */
import { launch, sleep } from './lib/cdp.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const FILE = resolve(process.cwd(), 'outputs/waveform-compare.html');
const OUT = resolve(process.cwd(), 'outputs');
mkdirSync(OUT, { recursive: true });

const b = await launch({ port: 9407, width: 1280, height: 1500 });
try {
  await b.goto(pathToFileURL(FILE).href);
  await sleep(1800);

  /* 每列: 找出比"该图背景亮度"明显更亮的像素, 量它离中轴的最远距离(=波形半高)。
   * c1 波形是 #fff@30% 叠在 #111116 上 → 约 #4a4a4c, 明显亮于底色但远弱于 c2/c3 的灰。
   * 阈值取"比该图最暗像素亮 12 以上", 这样三种画法都能被正确检出。 */
  const res = await b.eval(`(() => {
    const out = [];
    for (const id of ['c1','c2','c3']) {
      const c = document.getElementById(id);
      if (!c) { out.push({id, err:'missing'}); continue; }
      const ctx = c.getContext('2d');
      const W = c.width, H = c.height;
      const d = ctx.getImageData(0,0,W,H).data;
      const lum = (x,y) => { const i=(y*W+x)*4; return 0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]; };

      // 背景基准: 只统计**不透明**像素的最暗亮度。
      // (canvas 外的透明区 alpha=0 → RGB 读成 0, 会把阈值拉到 0 而失效)
      let lo = 255, sawOpaque = false;
      for (let y=0;y<H;y++) for (let x=0;x<W;x+=7) {
        const i=(y*W+x)*4;
        if (d[i+3] < 200) continue;            // 跳过透明像素
        sawOpaque = true;
        const v=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
        if (v<lo) lo=v;
      }
      if (!sawOpaque) { out.push({id, err:'no opaque pixel'}); continue; }
      const thr = lo + 12;

      // 只取**灰白色**像素当波形: c1/c2 波形是中性灰(#8a8a95 / #fff@30%叠底),
      // 而字幕块描边是绿色(R≫B)。用色相把两者分开, 否则块的边框会被算成"波形高度"。
      const isWave = (i) => {
        if (d[i+3] < 200) return false;
        const r=d[i], g=d[i+1], bl=d[i+2];
        const v=0.299*r+0.587*g+0.114*bl;
        if (v <= thr) return false;
        return Math.abs(r - bl) <= 14;        // 中性灰 → 波形;  绿框 r-bl≈+80 → 排除
      };

      // 中轴: 亮度重心行(波形上下对称分布)
      let sum=0, wsum=0;
      for (let y=0;y<H;y++){
        let s=0;
        for (let x=0;x<W;x+=5){
          const i=(y*W+x)*4;
          if (isWave(i)) s += 0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
        }
        sum+=s; wsum+=s*y;
      }
      const cy = wsum>0 ? Math.round(wsum/sum) : Math.round(H/2);

      const halves=[];
      for (let x=0;x<W;x+=3){
        let far=0;
        for (let y=0;y<H;y++){
          if (isWave((y*W+x)*4)) far=Math.max(far,Math.abs(y-cy));
        }
        halves.push(far);
      }
      halves.sort((a,b)=>a-b);
      const q=(p)=>halves[Math.floor(halves.length*p)]||0;

      /* 关键指标 —— 只统计**有声列**(half > 中轴的 15%)。
       * 静音段在三种画法里都是 0, 混进来会把"相对起伏"统一拉高, 掩盖差异。
       * 现状(c1)的病根正是: 有声段内每一列都被削到接近满高 → 该子集几乎无离散。 */
      const voiced = halves.filter(v => v > halves[halves.length>>1] * 0.15 + 1);
      const vs = voiced.slice().sort((a,b)=>a-b);
      const vq=(p)=>vs.length ? vs[Math.min(vs.length-1,Math.floor(vs.length*p))] : 0;
      const vmed=vq(0.5), v10=vq(0.1), v90=vq(0.9);
      out.push({id, W, H, cy, bgLum:+lo.toFixed(1),
        voicedCols: voiced.length,
        vMed: vmed, v10, v90,
        relVar: vmed>0 ? +((v90-v10)/vmed).toFixed(3) : 0,
        // 削顶比: 有声列里"半高 ≥ 本图有声段 p90"的占比 —— 现状应接近 1(整片削平成同一高度)
        clipRatio: voiced.length ? +(voiced.filter(v => v >= 0.95*v90).length / voiced.length).toFixed(3) : 0,
        // 纵向利用率: 有声段半高中位 / 可用半高(离中轴到带边缘) —— 太低说明波形被压得太矮
        useRatio: cy > 0 ? +(vmed / cy).toFixed(3) : 0,
      });
    }
    return out;
  })()`);

  console.log('\n=== canvas 渲染实测(灰度=波形; 有声段单独统计) ===');
  for (const r of res) {
    if (r.err) { console.log(r.id, 'ERROR', r.err); continue; }
    console.log(`${r.id}: ${r.W}x${r.H} 中轴y=${r.cy} 背景=${r.bgLum}  ` +
      `有声列=${r.voicedCols} 有声半高中位=${r.vMed} p10=${r.v10} p90=${r.v90}  ` +
      `有声段起伏=${r.relVar} 削顶列占比=${r.clipRatio} 纵向利用率=${r.useRatio}`);
  }

  const c1 = res.find(r => r.id === 'c1');
  const c2 = res.find(r => r.id === 'c2');
  const c3 = res.find(r => r.id === 'c3');

  const checks = [
    /* 判据说明 —— 阈值按实测语义定, 不追求"漂亮数字":
     * 现状的病是「动态范围被压掉」+「顶部削平」, 所以看两件事:
     *   有声段起伏(relVar): 有声列内部半高的离散度。c1 明显低 → 画出来是一坨。
     *   削顶列占比(clipRatio): 有声列里挤在最高 5% 高度的比例。c1 明显高 → 顶部被削平。
     * 注意 c1 的 useRatio 反而最高(0.707) —— 这正是"病态"的另一面:
     *   波形被撑得又高又平(全在顶部), 看着"很满"其实没有起伏。 */
    ['c1 现状: 有声段起伏小(<0.7)',        c1 && c1.relVar < 0.7],
    ['c1 现状: 削顶列占比高(>0.3)',        c1 && c1.clipRatio > 0.3],
    ['c2 仅修数据: 起伏显著(>1.0)',         c2 && c2.relVar > 1.0],
    ['c2 仅修数据: 削顶明显改善(<0.15)',    c2 && c2.clipRatio < 0.15],
    ['c3 完整修复: 起伏显著高于现状(>2x)',  c3 && c1 && c3.relVar > c1.relVar * 2],
    ['c3 完整修复: 起伏≥ c2',               c3 && c2 && c3.relVar >= c2.relVar - 0.05],
  ];

  console.log('\n=== 断言 ===');
  let ok = true;
  for (const [name, pass] of checks) { console.log((pass?'  PASS  ':'  FAIL  ')+name); if(!pass) ok=false; }

  await b.shot(resolve(OUT, 'wave-check.png'));
  console.log('\n截图 → outputs/wave-check.png');
  const logs = b.logs.filter(l => /error|exception/i.test(l));
  console.log('控制台异常:', logs.length ? logs : '无');
  process.exitCode = (ok && !logs.length) ? 0 : 1;
} catch (e) {
  console.error('探针失败:', e.message);
  process.exitCode = 1;
} finally {
  b.close();
}