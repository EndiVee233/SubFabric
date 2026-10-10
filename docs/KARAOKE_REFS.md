# \k 逐词字幕编辑 — 可参考的开源项目调研

> 2026-10-08 调研。面向「给 SubFabric 增加 \k 标签逐词编辑」这个大工程，
> 把 GitHub 上能参考的项目按**能力分层**归好类，并标明"拿来干什么、有什么坑"。
> 说明：这里只做参考与思路来源登记；**移植代码前必须先看对方 LICENSE**（表里已标已知项）。

---

## 〇、先把需求拆成五层，再看每层有什么可参考

| 层 | 要解决的问题 | 主要参考 |
|---|---|---|
| ① 语义与生成 | \k/\kf/\ko/\kt 怎么写、时长怎么算（厘秒）、解析与序列化 | Aegisub 生态 |
| ② 打轴/编辑交互 | 逐词/逐音节打时间、微调、行拆分、批量操作 | RhythmicaLyrics、StrangeUtaGame、karaoke-dev、karasplitter-web |
| ③ 词级时间来源 | 自动对齐、外部歌词格式（KRC/QRC/LRC/UltraStar）导入 | Lyric-Importer、LDDC、FA-Kara、yohane、ultrastar2ass |
| ④ 效果层（进阶） | 基于 \k 的 KFX 模板与自动生成（现在的颜色特效之外） | KaraEffector、PyonFX、The0x539、aegsc |
| ⑤ 预览/渲染 | 编辑器里实时看 \k 效果 | **libass 原生支持，现用的 SubtitlesOctopus 不用改**；JASSUB/ASS.js 备查 |

结论先放在这里：**SubFabric 要做的核心是 ①②③，这三层在开源界都有成熟先例，且有一个
"Web 端 + .ass 卡拉OK" 的直接近亲（karasplitter-web）**。④ 属于以后的可选扩展。

---

## 一、Aegisub 生态 —— \k 的事实标准（语义层的权威参考）

| 项目 | 情况 | 对 SubFabric 的用途 |
|---|---|---|
| [TypesettingTools/Aegisub](https://github.com/TypesettingTools/Aegisub) | C++，2.0k★，跨平台 ASS 编辑器；官网 [aegisub.org](https://aegisub.org/)（BSD-style 许可）。含 k-timing（kanji timing / 音节打轴）、Karaoke Templater（Lua auto4）、音频打轴界面 | **\k 语义、打轴手势、解析行为的权威参考**；看它怎么定义与处理 `\k/\kf/\ko/\kt`、k 时长以厘秒计 |
| [lost-logarithm/karaOK](https://github.com/lost-logarithm/karaOK) | Lua，38★，"Aegisub KFX library"：stock 模板器的增强版 + 工具库（随 AegisubDC 分发） | 模板器内部变量模型；**许可见仓库** |
| [The0x539/Aegisub-Scripts](https://github.com/The0x539/Aegisub-Scripts) | MoonScript，19★，重写版模板器（`0x.KaraTemplater.moon`）：mixins、条件执行、嵌套循环；[文档](https://github.com/petzku/The0x539-Aegisub-Scripts/blob/56d974b2747aaf26bb9754fbadd866b851c961ba/doc/0x.KaraTemplater.md) | **三代模板器里最现代的一代**；它对"input 行（kara 标记）→ 按 syl/word/char 逐单元产出"的模型值得抄 |
| [arch1t3cht《Programmer's Guide to Karaoke Templaters》](https://github.com/TheOneric/arch1t3cht-Aegisub-Scripts/blob/main/doc/templaters.md) | 文档 | 三种模板器的**对比与互转表**——理解"各家怎么切词、怎么引用词级数据"最快的入口 |
| [KaraEffect0r/Kara_Effector](https://github.com/KaraEffect0r/Kara_Effector) | Lua，77★，模板大合集 + 可视化改参 | ④ 层：看"模板参数化"怎么做 |
| [CoffeeStraw/PyonFX](https://github.com/CoffeeStraw/PyonFX) | Python，187★，用 Python 生成 KFX .ass | ④ 层：脚本化生成的接口设计 |
| [butterfansubs/aegsc](https://github.com/butterfansubs/aegsc) | **JS**，1★，卡拉OK模板编译器 | ④ 层但用 JS——若做"模板→\k 输出"的编译式方案可参考 |
| [Seekladoom/Aegisub-Karaoke-Effect-481-Templates](https://github.com/Seekladoom/Aegisub-Karaoke-Effect-481-Templates) | Lua，228★，481 个特效模板 | ④ 层素材库 |
| [qwe7989199/Lyric-Importer-for-Aegisub](https://github.com/qwe7989199/Lyric-Importer-for-Aegisub) | Lua，96★，**把 .krc/.qrc/.lrc 导入 Aegisub（生成逐词时间）** | ⭐ ③ 层最直接：中文词级歌词 → 行/词时间 → \k 的换算逻辑 |
| [qwe7989199/RubyTools](https://github.com/qwe7989199/RubyTools) | Lua，78★，日文注音注 ruby | 若将来做"注音/拼音"再回来看 |

> 学习资料总索引（含 K-Timing 指南等）：[fansubbers wiki · List of resources](https://fansubbers.miraheze.org/wiki/Guide:List_of_resources)（Timing / KFX 两节）。

## 二、打轴 / 编辑交互 —— ② 层的现成范式

| 项目 | 情况 | 对 SubFabric 的用途 |
|---|---|---|
| **RhythmicaLyrics** | ⚠ **非开源**（Windows 免费软件，作者 MIZUSHIKI，[vector 页面](https://www.vector.co.jp/soft/winnt/art/se416371.html)） | **交互抄它**：空格键打轴、切句时自动标记"该打几个音节"、10ms 级微调、变速播放、输出 ruby 扩展 LRC。它的"音拍感"打轴是业界公认顺手的 |
| [karaoke-studio/StrangeUtaGame](https://github.com/karaoke-studio/StrangeUtaGame) | Python，113★，"由 RhythmicaLyrics 启发的打轴软件"（GPL-3.0：只学交互） | 开源复刻版 RL 交互（空格打轴 + 播放同步）——**只看设计，不抄代码** |
| [Juna-Idler/RhythmiKaRuTTE](https://github.com/Juna-Idler/RhythmiKaRuTTE) | **JavaScript**，8★，浏览器里编辑 Karaoke 歌词时间标签（含 ruby） | ⭐ 稀有：**纯 JS 的"时间标签编辑器"**——和我们"浏览器里编 \k"最同构的先例之一 |
| [karaoke-dev/karaoke](https://github.com/karaoke-dev/karaoke) | C#，237★，osu!karaoke 系的卡拉OK系统，主题含 `karaoke-lyrics-editor` | 看它的**逐行/逐字歌词数据模型**与编辑 UI 组织（大型项目，挑着看） |
| **karasplitter-web** [Yurasubs/karasplitter-web](https://github.com/Yurasubs/karasplitter-web)（[在线版](https://ksplitter.kazeuta.com/)） | **Next.js 15 + TypeScript**；把 .ass 卡拉OK行**按 音节/字符/词 拆分**、**De-Ktime**（剥掉 `{\k}` 重置）、按 Actor/Style 过滤、即时预览、拖拽上传 .ass；仓库内还带原始 `ksplitter.py` | ⭐⭐ **Web 端 + .ass + \k 的最接近先例**。拆分策略（日文按罗马音音节、英文按词、去 \k 重置）与预览交互都可借鉴。**未见 LICENSE 文件 → 默认保留版权：参考思路，不要抄代码** |

## 三、词级时间的来源 —— ③ 层（导入与自动对齐）

| 项目 | 情况 | 对 SubFabric 的用途 |
|---|---|---|
| [chenmozhijin/LDDC](https://github.com/chenmozhijin/LDDC) | Python，1.8k★，**逐字歌词（QRC/KRC/eLRC 等）下载、解密、匹配** | 词级时间**数据源**：想支持"从音乐平台词级歌词生成 \k"，这里是现成的格式处理集 |
| [AxelTerizaki/ultrastar2ass](https://github.com/AxelTerizaki/ultrastar2ass) | **TypeScript**，7★，UltraStar（音节级时间）→ ASS | 另一个词级时间源的换算参考（TS 实现，易读） |
| [moriwx/FA-Kara](https://github.com/moriwx/FA-Kara) | Python，72★，**自动打轴**：人声分离 + 注音歌词 + MMS 强制对齐 → 输出 `o.ass`（Aegisub 可编辑）/ `o_rlf.lrc`（RL 可编辑）/ `o_ruby.lrc` | 自动化的完整管线样例。⚠ 走**本地模型**，与"本机不用本地识别"的约束冲突 → **优先级放最后** |
| [Japan7/yohane](https://github.com/Japan7/yohane) | Python，32★，Forced alignment for karaokes | 同上，对齐算法的实现参考 |
| [karamoe/karaokebase](https://github.com/karamoe/karaokebase) | kara.moe 的卡拉OK库（GitHub 为备份，主库在 GitLab；约 160GB） | **真实 \k 文件测试语料**：拿一批现成 karaoke .ass 做解析/往返测试 |

## 四、预览与渲染 —— ⑤ 层（基本不用动）

- **libass 原生支持 \k 全部标签**——SubFabric 现在用的 libass-wasm（subtitles-octopus）直接就能播 \k 效果，**渲染侧不需要改造**；要动的只有"编辑器侧的模型 + 时间轴/打轴 UI + 序列化"。
- 备查：[ThaUnknown/jassub](https://github.com/ThaUnknown/jassub)（TS，203★，另一套 libass wasm 播放器集成）、[weizhenye/ASS](https://github.com/weizhenye/ASS)（JS，665★，轻量 ASS 渲染器——**它的标签解析部分值得读**）。
- 播放器生态（了解就好）：[KaraokeMugen](https://gitlab.com/karaokemugen/karaokemugen-app)（mpv 系播放/管理器，主库在 GitLab）。

---

## 五、许可证核验（2026-10-08 逐个 API 实查；**移植代码只认 MIT / 同级宽松**）

**✅ MIT —— 可安全移植（保留版权声明即可）：**

| 项目 | 可移植的内容 |
|---|---|
| [Juna-Idler/RhythmiKaRuTTE](https://github.com/Juna-Idler/RhythmiKaRuTTE) | ⭐ 打轴交互 + 时间标签数据模型（详见"深读笔记"） |
| [AxelTerizaki/ultrastar2ass](https://github.com/AxelTerizaki/ultrastar2ass) | 音节时间 → `{\k}` 的 TS 实现在 `src/index.ts` |
| [moriwx/FA-Kara](https://github.com/moriwx/FA-Kara) | `norm2ass.py` = 词时间 → \k 写入器（含空档填充规范） |
| [Japan7/yohane](https://github.com/Japan7/yohane) | 卡拉OK 强制对齐（走本地模型，按约定排后） |
| [ThaUnknown/jassub](https://github.com/ThaUnknown/jassub) / [weizhenye/ASS](https://github.com/weizhenye/ASS) | libass 播放集成 / 轻量 ASS 渲染与解析（备查） |
| [butterfansubs/aegsc](https://github.com/butterfansubs/aegsc) | 卡拉OK模板编译器（JS） |
| [lyger/Aegisub_automation_scripts](https://github.com/lyger/Aegisub_automation_scripts)、[qwe7989199/aegisub_scripts](https://github.com/qwe7989199/aegisub_scripts) | Aegisub 自动化脚本集（挑着看） |
| [unanimated/luaegisub](https://github.com/unanimated/luaegisub) | **Unlicense（比 MIT 更宽松）** |

**⚠️ 无许可证 / 自定义许可 —— 只能参考"思路与事实"（格式、规则、交互），不要抄代码：**
- **Yurasubs/karasplitter-web**（最像我们的 Web 拆分工具——可惜无 LICENSE）
- **animefn/ksplitter**（原始拆分工具，无证；且已废弃，作者新作 AKSAL **也无证**）
- **qwe7989199/Lyric-Importer-for-Aegisub**（krc/qrc/lrc 导入——代码不能抄，**格式知识可用**）
- lost-logarithm/karaOK、The0x539/Aegisub-Scripts、KaraEffect0r/Kara_Effector、481 模板合集

**🚫 GPL-3.0 / LGPL-3.0 —— 与本项目现状不兼容，只学交互与设计：**
- [karaoke-dev/karaoke](https://github.com/karaoke-dev/karaoke)、[karaoke-studio/StrangeUtaGame](https://github.com/karaoke-studio/StrangeUtaGame)（打轴 UX）、[chenmozhijin/LDDC](https://github.com/chenmozhijin/LDDC)、[CoffeeStraw/PyonFX](https://github.com/CoffeeStraw/PyonFX)（LGPL）

**其他：** TypesettingTools/Aegisub 为混合许可（GitHub 标 NOASSERTION，主体 BSD-3）→ 当**语义/行为参考**；
karamoe/karaokebase 语料许可需按曲核实。

> **可移植清单（结论）** = RhythmiKaRuTTE（交互+模型）+ ultrastar2ass（\k 换算）+ FA-Kara（写入规范）+
> yohane（对齐，后置）+ jassub / weizhenye-ASS（解析备查）。其余项目一律当"设计参考"。

---

## 六、对 SubFabric 的落地映射（初步，供下一步设计）

1. **数据模型**：现有的词级 span `{w, s, e}` 直接可推导 \k——`k = round((e - s) * 100)`（厘秒）。
   \k 模式本质是"把 words[] 序列化进事件文本"的另一条序列化通道，**分析/编辑层可以复用现有 karaoke.js 管线**。
2. **生成/解析**：新增 `\k` 读写器（参考 Aegisub 对 `\k/\kf/\ko/\kt` 的定义；The0x539 文档里"按 syl/word/char 切单元"的模型最清晰）。
3. **编辑交互（本项目的重头）**：
   - 打轴手势参考 RhythmicaLyrics / StrangeUtaGame：播放中空格打点、自动预标记音节位置、10ms 级微调；
   - 行拆分参考 ksplitter 的三种模式（音节/字符/词）＋ De-Ktime（剥 `{\k}` 重置再重打）；
   - 浏览器内先例：RhythmiKaRuTTE（JS 时间标签编辑）、karasplitter-web（Web .ass karaoke 工具）。
4. **导入/导出**：\k 版本与现有"颜色标签"版本**并存、可互转**（设置里切换输出模式）；
   导入侧可后补 KRC/QRC/LRC（Lyric-Importer 思路）。
5. **自动打轴**：FA-Kara/yohane 路线**与"本机不得用本地识别"冲突，排到最后**；若要做，优先考虑"用已有词级时间数据（LRC/QRC）直接生成"，而不是本地强制对齐。
6. **测试**：用 kara.moe 的真实 karaoke .ass 语料做 \k 解析/往返/渲染回归。

## 七、深读笔记（MIT 项目源码级，2026-10-08）

### RhythmiKaRuTTE（浏览器时间标签编辑器）—— 交互与模型的核心参考
- **数据模型**（`js/RKLyrics.js`）：歌词 = 行[]；行 = 单元(unit)[]；单元内保留**逐字**的
  `text_array / start_times / end_times`（毫秒，-1 = 未定）+ 每个时间点的 `;option` 修饰位。
  缺失时间用 `Complement()` 在已知点之间**按字数比例**插值：
  `divtime = (prev.time * next.count + next.time * prev.count) / (prev.count + next.count)`。
- **打点交互**（`js/Mode_Stamp.js`）—— 键位与行为可直接借鉴：
  - `Space/Enter` 打点（记录 `audio.currentTime`）；**按住 = 计入结束点**（松开时记 `]`）；
  - `A/D`・`←/→` 步进相邻点；`W/S`・`↑/↓` 换行并把播放头跳到该行首点；
  - `Z/X/C` = 退 1 秒 / 播放暂停 / 进 1 秒；`e.repeat` 过滤防止连发；
  - 波形视图：播放头固定屏宽 **30%** 位置；打点画成竖线（当前点绿、本行红、相邻行蓝）并在旁标文字；
  - 暂停时可**拖动打点竖线微调**（16px 命中带，grab 光标）。
- **序列化**：`[mm:ss.xx;p]`（起点）/ `[mm:ss.xx;up]`（结束点）/ `[00:00.00;pn]`（未打）——
  用 `;option` 位把"起点还是终点"写进时间标签本身。

### FA-Kara `norm2ass.py`（词时间 → \k 写入器）—— 生成侧规范
- 逐单元 `{\k<厘秒>}`；**单元之间没有词的空档也会补一个 `{\k<gap>}`**；
- 行首/行尾各加 **20 厘秒** padding（pretime/posttime）；
- `{\k0}` 用于零时值单元/行首非歌词内容占位；
- ruby 行用 `#|` 与 `基字|<ruby` 标记（NicoKaraMaker 语法）—— SubFabric 用不到，但可参考
  "一个单元里放非朗读内容"的写法。

### ultrastar2ass `src/index.ts`（音节时间 → \k）
- `{\k` + **`Math.floor(ms / 10)`**（厘秒、向下取整）；音节文本自动处理前后空格归属；
- 行首固定 `{\k100}` 前奏拍；开始时间提前 900ms 但钳到 0；
- 同时输出 Dialogue（特效）与 **Comment（Effect=karaoke）** 两行，Comment 留给其它工具读纯 k 文本。

### 修正过的认知
- **ksplitter 已废弃且无许可证**（作者新作 AKSAL 也无证）→ 拆分逻辑只能自己写（中/英场景本就简单：
  英文按空格、中文按字；日文罗马音音节才是难点）；
- **karasplitter-web 无许可证** → 之前列的"最接近先例"只能当交互设计参考；
- GitHub 上不存在叫 "kfx" 的 Aegisub 官方仓库——"KFX" 是概念（Karaoke Effects）。

## 八、建议的下一步（更新）

1. ✅ 许可证核验 + 两个"最小闭环"源码深读（本轮完成，笔记见上）。
2. **下一份交付：SubFabric 的 \k 方案设计稿**，覆盖：
   - 数据模型：现有词级 span `{w, s, e}` ↔ `\k` 时长（厘秒）互转；\k 模式的事件形态；
   - 打轴交互：并入现有时间轴的键位草案（打点/按住=结束/步进/走带/拖动微调）；
   - 断点填补：FA-Kara 的 gap 填充 vs RhythmiKaRuTTE 的比例插值（选型）；
   - 与颜色标签方案的关系：并存 vs 互斥、导出选项、互转器；
   - 分阶段落地：P1 只读解析+预览 → P2 打轴 → P3 拆分/导入 → P4 自动对齐（后置）。
3. 设计稿确认后再动工；渲染侧零改造（libass 原生支持 \k）。
