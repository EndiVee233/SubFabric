#!/bin/bash
cd "$(dirname "$0")/editor"
# 先清掉可能还占着 8321 的旧实例
lsof -ti tcp:8321 2>/dev/null | xargs -r kill 2>/dev/null
(open http://127.0.0.1:8321/ 2>/dev/null || xdg-open http://127.0.0.1:8321/ 2>/dev/null) &
node server.js
