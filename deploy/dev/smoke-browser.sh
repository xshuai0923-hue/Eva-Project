#!/bin/zsh
# 在本机实例上用真实浏览器把顶栏搜索、需求池和交接页的关键路径点一遍：同一套步骤
# （smoke/scenarios.mjs）在无头 Chrome 和 WKWebView（Safari 同款引擎）各跑一次，鼠标和
# 按键都是真实事件，输入法选字也在里面。只用于本机测试实例：它签发自动登录令牌，那是写操作。
#
# 为什么要有 WebKit 这一遍：#218 上线后，Safari 里用拼音输入法要点两次才能打开搜索结果，
# 只在 Chrome 里点一遍是发现不了的。
#
# 浏览器碰不到令牌：令牌只用来让 curl 换出会话，会话由只监听 127.0.0.1 的
# session-proxy.mjs 持有，浏览器只连它。令牌和 cookie 只放临时目录，结束时删掉目录并作废
# 这次签的令牌。
#
# 用法：smoke-browser.sh [搜索词]   默认「分页」，本机数据里需求和交接两组都能搜到
#       EVAPROJECT_SMOKE_ONLY=chrome|webkit 只跑其中一个引擎
set -eu
# The caller's PATH is kept: node may live in a version manager's directory.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
for tool in node swiftc curl docker-compose; do
  whence -p "$tool" >/dev/null || { print -u2 -- "缺少 $tool"; exit 1; }
done

project_root="${EVAPROJECT_LOCAL_SOURCE:-${0:A:h:h:h}}"
local_root="${EVAPROJECT_LOCAL_ROOT:-/Users/Shared/Eva-Project-local}"
env_file="$local_root/runtime/.env"
web_port="${EVAPROJECT_LOCAL_WEB_PORT:-28080}"
proxy_port="${EVAPROJECT_SMOKE_PROXY_PORT:-28090}"
query="${1:-分页}"
export DOCKER_CONTEXT="colima-evaproject-local"

grep -q '192\.168\.80\.4' "$env_file" && { print -u2 -- "拒绝：目标不是本地实例"; exit 1; }

compose() {
  docker-compose --project-name eva-project-local --env-file "$env_file" \
    -f "$project_root/vendor/openproject-docker-compose/docker-compose.yml" \
    -f "$project_root/deploy/docker-compose.override.yml" "$@"
}

work="$(mktemp -d)"
proxy_pid=""
minted=""
token=""
cleanup() {
  [ -n "$proxy_pid" ] && kill "$proxy_pid" 2>/dev/null
  rm -rf "$work"
  [ -n "$minted" ] || return 0
  # 作废这次签的令牌；令牌从标准输入进 rails runner，不出现在进程参数里。没能读出令牌时，
  # 作废 admin 的全部自动登录令牌——autologin.rb 每次签发前本来也会这样清一遍。
  if [ -n "$token" ]; then
    print -r -- "Token::AutoLogin.find_by_plaintext_value(\"$token\")&.destroy"
  else
    print -r -- 'Token::AutoLogin.where(user: User.find_by!(login: "admin")).destroy_all'
  fi | compose exec -T web bundle exec rails runner - >/dev/null 2>&1 ||
    print -u2 -- "⚠️ 自动登录令牌没能作废：在 web 容器里 rails runner 手动销毁 admin 的 Token::AutoLogin"
}
trap cleanup EXIT

minted="$(compose exec -T web bundle exec rails runner - < "$project_root/deploy/dev/autologin.rb" 2>/dev/null | tail -1)"
token="$(print -r -- "$minted" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).value)')"
# 第一跳把 HTML 会话换出来；之后只用会话，令牌不再出场。
curl -s -o /dev/null -b "autologin=$token" -c "$work/jar" "http://localhost:$web_port/requirements"
grep -q _open_project_session "$work/jar" || { print -u2 -- "没能用令牌换出会话"; exit 1; }

node "$project_root/deploy/dev/session-proxy.mjs" "$work/jar" "$proxy_port" "http://localhost:$web_port" \
  > "$work/proxy.log" 2>&1 &
proxy_pid=$!
for attempt in {1..50}; do
  curl -s -o /dev/null "http://127.0.0.1:$proxy_port/" && break
  sleep 0.2
done
base="http://127.0.0.1:$proxy_port"

failures=0
print -r -- "搜索词「$query」"
only="${EVAPROJECT_SMOKE_ONLY:-}"
if [ "$only" != webkit ]; then
  print -r -- ""
  print -r -- "Chrome（无头，DevTools 协议）"
  node "$project_root/deploy/dev/smoke/chrome.mjs" "$base" "$query" || failures=$((failures + 1))
fi
if [ "$only" != chrome ]; then
  print -r -- ""
  print -r -- "WebKit（WKWebView，Safari 同款引擎）"
  node "$project_root/deploy/dev/smoke/scenarios.mjs" "$query" > "$work/scenarios.json"
  if ! swiftc -O -o "$work/webkit-smoke" "$project_root/deploy/dev/smoke/webkit.swift" 2> "$work/swiftc.log"; then
    cat "$work/swiftc.log" >&2
    print -u2 -- "✗ WebKit 执行器没编译过"
    exit 1
  fi
  "$work/webkit-smoke" "$base" "$work/scenarios.json" || failures=$((failures + 1))
fi

print -r -- ""
if [ "$failures" -ne 0 ]; then
  print -u2 -- "✗ 有场景没通过。"
  exit 1
fi
print -r -- "✓ 两个引擎全部通过。"
