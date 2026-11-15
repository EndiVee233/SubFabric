export const assFixture = `[Script Info]
; Android preservation fixture
Title: 安卓 ASS 编辑验收
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0

[Aegisub Project Garbage]
Custom Metadata: keep this exact value

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK SC,48,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,25,25,38,1
Style: 中文,Noto Sans CJK SC,48,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,25,25,95,1
Style: Title,Noto Sans CJK SC,40,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,8,25,25,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Comment: 0,0:00:00.00,0:00:00.00,Default,,0,0,0,,preserve comment
Dialogue: 0,0:00:01.00,0:00:03.50,中文,Host,0,0,0,,[Host]你好，世界。
Dialogue: 0,0:00:01.00,0:00:02.00,Default,Host,0,0,0,,{\\c&H00FF00&}Hello{\\c} world.
Dialogue: 0,0:00:02.00,0:00:03.50,Default,Host,0,0,0,,Hello {\\c&H00FF00&}world.{\\c}
Dialogue: 1,0:00:05.00,0:00:08.00,Title,Title,40,50,60,custom-effect,{\\pos(640,160)\\bord4\\i1}Keep, this title
`;
