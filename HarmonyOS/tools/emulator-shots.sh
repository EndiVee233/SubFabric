#!/usr/bin/env bash
# 一键：等模拟器就绪 → 装包 → 启动 → 抓图
#
# 前置：模拟器已从 DevEco 的 Device Manager 启动（外部启动会被 DSH 拒掉，
#       报 Failed to register window class / Failed to open settings hive）。
# 用法：
#   bash tools/emulator-shots.sh                # 抓当前已连上的设备
#   PORT=phone bash tools/emulator-shots.sh     # 指定输出前缀
#
# 产物：docs/preview/shot-<port>-home.png（整屏截图）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HDC="D:/HarmonyOS/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe"
HAP="$ROOT/entry/build/default/outputs/default/entry-default-signed.hap"
OUT="$ROOT/docs/preview"
BUNDLE="com.subfabric.harmony"
ABILITY="EntryAbility"
TAG="${PORT:-device}"

[ -x "$HDC" ] || { echo "找不到 hdc：$HDC"; exit 1; }
[ -f "$HAP" ] || { echo "找不到签名包：$HAP（先跑一次 assembleHap）"; exit 1; }

echo "== 等待设备 =="
for i in $(seq 1 120); do
  target="$("$HDC" list targets 2>&1 | tr -d '\r' | grep -v '\[Empty\]' | grep -v '^$' | head -1 || true)"
  if [ -n "${target:-}" ]; then echo "已连接：$target"; break; fi
  sleep 2
  if [ "$i" = "120" ]; then echo "120 次轮询仍未发现设备；请确认模拟器已启动"; exit 1; fi
done

echo "== 安装 =="
"$HDC" install -r "$HAP"

echo "== 启动 =="
"$HDC" shell aa start -a "$ABILITY" -b "$BUNDLE" || true

echo "== 等首帧（8s）=="
sleep 8

echo "== 抓图 =="
mkdir -p "$OUT"
"$HDC" shell snapshot_display -f /data/local/tmp/shot.jpeg
"$HDC" file recv /data/local/tmp/shot.jpeg "$OUT/shot-$TAG-home.png"
"$HDC" shell rm -f /data/local/tmp/shot.jpeg
echo "完成：$OUT/shot-$TAG-home.png"
