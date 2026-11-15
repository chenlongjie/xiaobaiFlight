#!/usr/bin/env bash
# ============================================================
# 小白乱飞 → Netlify 一键生产部署（仓库根 = 站点根）
#
# 用法：  bash deploy.sh
#
# 凭据：  从 ~/Downloads/cookies.txt 自动提取 Netlify 浏览器会话
#         `_nf-auth`（价值形如 nfu_xxx，可用环境变量 NETLIFY_COOKIES
#         覆盖 cookies 文件路径）。须知：
#         · 不是 PAT！此账号为 SSO 登录，个人访问令牌权限受限；
#         · 不用 netlify CLI（cli 登录账号与站点 Owner 不同，无权）；
#         · _nf-auth 会随浏览器会话过期，失效时重新导出 cookies。
#
# 网络：  默认走本机 127.0.0.1:7897 代理（Clash 混合端口），
#         可用环境变量 NETLIFY_PROXY 覆盖，或置空走直连。
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

SITE_ID="576984e3-5331-494f-a85e-861be6e20798"          # xiaobai-flight
API="https://api.netlify.com/api/v1"
COOKIES="${NETLIFY_COOKIES:-$HOME/Downloads/cookies.txt}"
PROXY="${NETLIFY_PROXY:-http://127.0.0.1:7897}"
ZIP="${TMPDIR:-/tmp}/xiaobai-flight-site.zip"

# 代理 curl；PROXY 为空则直连
cget() { if [ -n "$PROXY" ]; then curl -s -x "$PROXY" -m 30 "$@"; else curl -s -m 30 "$@"; fi; }

echo "① 提取 _nf-auth 会话令牌…"
TOKEN="$(awk -F'\t' '$6=="_nf-auth"{print $7; exit}' "$COOKIES" 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  echo "✗ 未找到 _nf-auth。请确认已用能打开 xiaobai-flight 后台的账号(Owner=KAO)登录 Netlify，"
  echo "  并从浏览器导出 cookies 到 ${COOKIES}（Netscape 格式）。"
  exit 1
fi

echo "② 验证令牌（GET sites/${SITE_ID}）…"
CODE="$(cget -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$API/sites/$SITE_ID")"
if [ "$CODE" != "200" ]; then
  echo "✗ 令牌无效或已过期（HTTP ${CODE}）。请重新登录 Netlify 并刷新 cookies.txt，或检查代理 ${PROXY}。"
  exit 1
fi

echo "③ 打包仓库根（排除 .git/.codefree/node_modules/wuxia-3d-fight 等无关内容）…"
rm -f "$ZIP"
zip -qr "$ZIP" . \
  -x ".git/*" -x ".codefree/*" -x "node_modules/*" \
  -x "wuxia-3d-fight/*" -x ".DS_Store" -x "deploy.sh"
SIZE="$(du -h "$ZIP" | cut -f1)"
echo "   包体 $SIZE / $(unzip -l "$ZIP" | tail -1 | awk '{print $2}') 文件"

echo "④ 上传部署…"
RESP="$(cget -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary @"$ZIP" \
  "$API/sites/$SITE_ID/deploys" || true)"
DEPLOY_ID="$(printf '%s' "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || true)"
if [ -z "$DEPLOY_ID" ]; then
  echo "✗ 上传失败，响应：$(printf '%s' "$RESP" | head -c 400)"
  echo "  提示：确认代理已开启（curl -x $PROXY 探活），或设 NETLIFY_PROXY= 改直连。"
  exit 1
fi
echo "   部署 ID: ${DEPLOY_ID}，轮询状态…"

echo "⑤ 等待部署 ready…"
for i in 1 2 3 4 5 6 7 8 9 10; do
  STATE="$(cget -H "Authorization: Bearer $TOKEN" "$API/deploys/$DEPLOY_ID" \
    | python3 -c "import json,sys;print(json.load(sys.stdin).get('state',''))" 2>/dev/null || true)"
  echo "   检查 $i: $STATE"
  [ "$STATE" = "ready" ] && break
  [ "$STATE" = "error" ]  && { echo "✗ 部署失败"; exit 1; }
  sleep 3
done

if [ "$STATE" != "ready" ]; then
  echo "⚠ 等待超时，请到 https://app.netlify.com/sites/xiaobai-flight/deploys 手动检查"
  exit 1
fi

echo "=============================================="
echo "✅ 上线成功：https://xiaobai-flight.netlify.app/"
echo "   验证：curl -s https://xiaobai-flight.netlify.app/src/net.js | head -c 60"
echo "=============================================="