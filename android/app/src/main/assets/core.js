/** Shared, pure subtitle guards. SRT parsing and time formatting reuse upstream modules. */
export function validateCues(cues) {
  if (!Array.isArray(cues) || cues.length > 20000) throw new Error('字幕数量超过原型上限');
  for (const cue of cues) {
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || cue.end > 7 * 24 * 3600) throw new Error('时间无效，结束时间须晚于开始时间');
    if (!Array.isArray(cue.lines) || cue.lines.some(line => typeof line !== 'string') || cue.lines.join('\n').length > 100000) throw new Error('字幕内容无效或过长');
  }
  return cues;
}
export function timelineEnd(cues, duration) {
  return Math.max(1, Number.isFinite(duration) ? duration : 0, ...cues.map(cue => cue.end));
}
export function exampleCues() {
  return [
    { id: 1, start: 0, end: 3.2, lines: ['Make every word count.', '让每一句，都恰到好处。'] },
    { id: 2, start: 3.5, end: 7.4, lines: ['Your stories go wherever you go.', '带上你的故事，随时开始。'] },
    { id: 3, start: 7.8, end: 11.5, lines: ['This is an editing example, not a recognition result.', '这是编辑示例，并非语音识别结果。'] },
  ];
}
