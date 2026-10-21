import assert from 'node:assert/strict';
import {
  DEFAULTS, mdxArgs, buildArgs, parseProgress, toSegments, joinWords,
} from '../editor/faster-whisper.js';

// ── MDX 参数跨版本兼容 ──
assert.deepEqual(mdxArgs('--ff_mdx_kim2 ...'), ['--ff_mdx_kim2']);
assert.deepEqual(mdxArgs('--ff_vocal_extract mdx_kim2 ...'), ['--ff_vocal_extract', 'mdx_kim2']);
assert.deepEqual(mdxArgs(''), ['--ff_mdx_kim2']);

// ── 命令行：默认关 VAD、开人声分离、逐词、无 prompt ──
const args = buildArgs({
  audio: 'C:/p/audio.wav', modelDir: 'C:/m', outputDir: 'C:/out', helpText: '--ff_mdx_kim2',
});
assert.equal(DEFAULTS.vad, false, '默认关 VAD：VAD 会切掉短词');
assert.ok(args.includes('--model') && args.includes('large-v2'));
assert.ok(args.includes('--ff_mdx_kim2'));
assert.ok(args.includes('--word_timestamps') && args.includes('True'));
assert.ok(args.includes('--vad_filter') && args.includes('False'));
assert.ok(!args.includes('--initial_prompt'), '默认不给 prompt');
assert.ok(args.includes('--print_progress'));
assert.ok(args.includes('--beep_off'));

// 显式开 VAD / 带 prompt
const args2 = buildArgs({
  audio: 'a.wav', modelDir: 'm', outputDir: 'o', vad: true, vadThreshold: 0.2,
  prompt: 'Wemmbu', helpText: '--ff_vocal_extract',
});
assert.ok(args2.includes('--vad_filter') && args2.includes('True'));
assert.ok(args2.includes('--vad_threshold') && args2.includes('0.2'));
assert.ok(args2.includes('--ff_vocal_extract') && args2.includes('mdx_kim2'));
assert.ok(args2.includes('--initial_prompt') && args2.includes('Wemmbu'));

// 参数字段真正进入命令行：语言 / VAD 方法 / 关人声分离 / 关逐词
const args3 = buildArgs({
  audio: 'a.wav', modelDir: 'm', outputDir: 'o', language: 'zh', vad: true,
  vadThreshold: 0.3, vadMethod: 'silero_v5', vocalExtract: false, wordTimestamps: false,
  helpText: '--ff_vocal_extract',
});
assert.ok(args3.includes('--language') && args3.includes('zh'));
assert.ok(args3.includes('--vad_method') && args3.includes('silero_v5'));
assert.ok(args3.includes('--vad_threshold') && args3.includes('0.3'));
assert.ok(args3.includes('--word_timestamps') && args3.includes('False'));
assert.ok(!args3.includes('--ff_vocal_extract'));

// ── 进度解析 ──
assert.equal(parseProgress('  4% |  26/600 | ...'), 4);
assert.equal(parseProgress('100% | 600/600'), 100);
assert.equal(parseProgress('no progress'), null);
assert.equal(parseProgress('999%'), 100);

// ── XXL JSON → SubFabric segments ──
const raw = {
  segments: [
    {
      start: 0, end: 2.0, text: ' Hello world.',
      words: [
        { start: 0, end: 0.5, word: ' Hello', probability: 0.9 },
        { start: 0.5, end: 1.0, word: ' world.', probability: 0.8 },
      ],
    },
    {
      start: 2.1, end: 2.3, text: '',
      words: [{ start: 2.1, end: 2.3, word: ' Next', probability: 0.7 }],
    },
  ],
};
const out = toSegments(raw);
assert.equal(out.segments.length, 2, '句号/长停顿处断句');
assert.equal(out.segments[0].text, 'Hello world.');
assert.equal(out.segments[0].words.length, 2);
assert.equal(out.segments[0].confidence.score, 0.85);
assert.equal(out.segments[0].confidence.parts.token, 0.85);
assert.equal(out.segments[1].text, 'Next');

// 没有词级时间戳时按词数均分（不能整段丢失）
const noWords = toSegments({ segments: [{ start: 10, end: 12, text: 'one two three four' }] });
assert.equal(noWords.segments.length, 1);
assert.equal(noWords.segments[0].words.length, 4);
assert.ok(Math.abs(noWords.segments[0].words[1].start - 10.5) < 1e-6);

// 空输出
assert.deepEqual(toSegments({ segments: [] }).segments, []);
assert.throws(() => toSegments({ nope: 1 }), /segments/);

// 中文词之间不加空格
assert.equal(joinWords([{ word: '你好' }, { word: '世界' }]), '你好世界');
assert.equal(joinWords([{ word: 'hello' }, { word: 'world' }]), 'hello world');

console.log('faster-whisper-test: ok');
