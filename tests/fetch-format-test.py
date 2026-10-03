# -*- coding: utf-8 -*-
"""下载内核纯逻辑单测（不联网、不下载）: python tests/fetch-format-test.py

覆盖: URL 判站 · 档位→yt-dlp -f 表达式 · cookie 解析(Netscape/请求头/JSON) · Netscape 往返 · 登录态描述不泄露值。
"""
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "asr"))

from fetch import bilibili as bili          # noqa: E402
from fetch import selector as sel           # noqa: E402

passed = failed = 0


def ok(cond, name, extra=None):
    global passed, failed
    if cond:
        passed += 1
        print("  ok  " + name)
    else:
        failed += 1
        print("FAIL  " + name + ("" if extra is None else " :: " + repr(extra)))


print("== 站点判定 ==")
ok(sel.site_of("https://www.bilibili.com/video/BV1xx411c7mD") == "bilibili", "bilibili.com → bilibili")
ok(sel.site_of("https://b23.tv/abc123") == "bilibili", "b23.tv 短链 → bilibili")
ok(sel.site_of("https://www.youtube.com/watch?v=dQw4w9WgXcQ") == "youtube", "youtube.com → youtube")
ok(sel.site_of("https://youtu.be/dQw4w9WgXcQ") == "youtube", "youtu.be → youtube")
ok(sel.site_of("https://vimeo.com/123") == "", "其他站点 → 不支持")
ok(sel.site_of("") == "" and sel.site_of(None) == "", "空值安全")
ok(sel.supported("https://b23.tv/x") and not sel.supported("https://vimeo.com/1"), "supported() 正确")

print("\n== 画质选项表 ==")
bq = sel.quality_choices("https://www.bilibili.com/video/BV1xx411c7mD")
yq = sel.quality_choices("https://youtu.be/x")
ok(any(x.get("value") == 80 for x in bq), "bilibili 表里有 1080P(qn=80)", bq[:3])
ok(any(x.get("value") == 1080 for x in yq), "YouTube 表里有 1080", yq[:3])
ok(sel.quality_choices("https://vimeo.com/1") == [], "不支持的站点没有画质表")

print("\n== 档位 → -f 表达式 ==")
B = "https://www.bilibili.com/video/BV1xx411c7mD"
Y = "https://www.youtube.com/watch?v=x"
FB = "bestvideo+bestaudio/best"

best_b = sel.build_format_selector(B, "best")
ok(bool(best_b) and FB in best_b, "bilibili best 非空且带兜底", best_b[:80])
many_b = sel.build_format_selector(B, "1080")
ok(FB in many_b and ("116" in many_b or "112" in many_b or "80" in many_b), "bilibili 1080 → 含 1080 档候选", many_b[:110])
ok(many_b != best_b, "bilibili 1080 与 best 不是同一个表达式")
q720 = sel.build_format_selector(B, "720")
ok(FB in q720 and "116" not in q720, "bilibili 720 不包含 1080 专档(116)", q720[:110])
ok(sel.build_format_selector(B, "worst").startswith("worstvideo"), "worst → worstvideo 链")
au = sel.build_format_selector(B, "audio")
ok("audio" in au.lower(), "audio → 音频链", au[:60])
ok(sel.build_format_selector(B, "custom", None, "137+140") == "137+140", "custom 原样返回")
ok(sel.build_format_selector(B, "bili:80").startswith(best_b.split("/")[0]) or "80" in sel.build_format_selector(B, "bili:80"), "bili:<qn> 走指定档")
ok("height<=?720" in sel.build_format_selector(Y, "720"), "YouTube 720 → 带 height 约束", sel.build_format_selector(Y, "720")[:110])
ok(FB in sel.build_format_selector(Y, "best"), "YouTube best 带兜底")
ok(FB in sel.build_format_selector(Y, "1080"), "YouTube 1080 带兜底")
ok(sel.build_format_selector(B, "不存在的档位") == best_b, "未知档位退回 best")
ok(" " not in best_b and "/" in best_b, "表达式不含空格且是链式")

print("\n== qn 候选高度映射 ==")
c1080 = sel._bili_qn_candidates(1080)
c720 = sel._bili_qn_candidates(720)
ok(80 in c1080 and 116 in c1080, "1080 档候选含 80/116", c1080)
ok(80 not in c720 and 64 in c720, "720 档候选不含 80、含 64", c720)
ok(c1080.index(116) < c1080.index(80), "高码率/60帧排在普通 1080 之前", c1080)
ok(sel._bili_qn_candidates(100) == [], "极低档没有候选（退回 best）")

print("\n== Cookie 解析 ==")
hdr = "SESSDATA=abc%2Cdef; bili_jct=xyz; DedeUserID=12345"
c1 = bili.parse_cookie_input(hdr)
ok(c1.get("SESSDATA") == "abc%2Cdef" and c1.get("bili_jct") == "xyz" and c1.get("DedeUserID") == "12345", "请求头写法", c1)
c2 = bili.parse_cookie_input('{"SESSDATA": "v1", "bili_jct": "v2"}')
ok(c2.get("SESSDATA") == "v1" and c2.get("bili_jct") == "v2", "JSON 写法", c2)
ok(bili.parse_cookie_input("") == {} and bili.parse_cookie_input(None) == {}, "空值安全")
ok(bili.has_login(c1) and not bili.has_login({"foo": "1"}), "登录态判定看 SESSDATA")
ok("abc" not in bili.describe_login(c1), "describe_login 不泄露 cookie 值", bili.describe_login(c1))
ok("未提供" in bili.describe_login({}), "没有 cookie 时给的是「未提供」", bili.describe_login({}))

# 只复制到「值」的情况（DevTools 里最容易发生）—— 以前解析成空 cookie，等于未登录
BARE = "ac87ca47%2C1806119310%2C8b687%2A91CjBdFFu6xh85n-qW9bEpg_kl6A8Gn4kob5cKqsWlPTtS0JhbBEvtSxwnwgtdrKL"
cb = bili.parse_cookie_input(BARE)
ok(cb.get("SESSDATA") == BARE, "只贴了值 → 按 SESSDATA 收下", list(cb.keys()))
ok(bili.has_login(cb), "只贴了值也算已登录")
ok("已提供登录 Cookie" in bili.describe_login(cb) and BARE[:8] not in bili.describe_login(cb), "裸值也能判成登录态且不泄露值", bili.describe_login(cb))
ok(bili.parse_cookie_input(BARE + ";").get("SESSDATA") == BARE, "尾部多个分号也认")
ok(bili.parse_cookie_input("短值") == {}, "太短的不当 SESSDATA（避免把随手写的东西当 cookie）")
ok(bili.parse_cookie_input("not a cookie at all") == {}, "带空格的一串字不当 cookie")

print("\n== 分P（bilibili 多P） ==")
PV = "https://www.bilibili.com/video/BV1xx411c7mD"
ok(bili.part_of(PV) == 1, "没写 ?p= → 1")
ok(bili.part_of(PV + "?p=3") == 3 and bili.part_of(PV + "?spm_id_from=333&p=7") == 7, "读得出 ?p=")
ok(bili.set_part(PV, 1) == PV, "part=1 不往 URL 上加参数（p=1 就是默认行为）")
ok(bili.set_part(PV, 3) == PV + "?p=3", "part=3 → 补 ?p=3")
ok(bili.set_part(PV + "?spm_id_from=333", 3).endswith("&p=3"), "已有其它查询参数 → 用 & 接")
ok(bili.set_part(PV + "?p=5", 3) == PV + "?p=5", "链接里已经写了 ?p= 就以链接为准")
ok(bili.set_part("", 3) == "", "空 URL 安全")

print("\n== Netscape 往返 ==")
with tempfile.TemporaryDirectory() as d:
    p = Path(d) / "c.txt"
    bili.write_netscape({"SESSDATA": "s3cr3t", "bili_jct": "j1"}, p)
    txt = p.read_text(encoding="utf-8")
    ok(txt.startswith("# Netscape HTTP Cookie File"), "文件头正确")
    first = [l for l in txt.splitlines() if l and not l.startswith("#")][0]
    ok(first.startswith(".bilibili.com\t") and len(first.split("\t")) == 7, "第一条 cookie 是 7 列 tab 分隔的 Netscape 格式", first[:60])
    back = bili.read_netscape(p)
    ok(back.get("SESSDATA") == "s3cr3t" and back.get("bili_jct") == "j1", "写出去再读回来一致", back)
    ok(bili.parse_cookie_input(txt).get("SESSDATA") == "s3cr3t", "整份文件内容也能直接解析", bili.parse_cookie_input(txt))


print("\n== CLI 契约（离线, 不下载） ==")
import subprocess  # noqa: E402

CLI = str(HERE.parent / "asr" / "fetch" / "fetch_cli.py")
r = subprocess.run([sys.executable, CLI, "--url", "https://vimeo.com/123", "--out", tempfile.gettempdir()],
                   capture_output=True, text=True, encoding="utf-8")
ok(r.returncode == 2, "不支持的站点 → 退出码 2", r.returncode)
ok("只支持 bilibili" in (r.stdout or ""), "不支持的站点 → 一句人话的 error JSON", (r.stdout or "")[:120])
r2 = subprocess.run([sys.executable, CLI, "--help"], capture_output=True, text=True, encoding="utf-8")
ok(r2.returncode == 0 and "--quality" in (r2.stdout or ""), "--help 正常", r2.returncode)

print("\n%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)