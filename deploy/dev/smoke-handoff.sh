#!/bin/zsh
# 带真实登录态把交接功能的每条路径点一遍。只用于本机测试实例。
#
# 为什么不能只 curl 一次就下结论：自动登录令牌只能换来 HTML 会话，API v3 不认它。
# 不存 cookie 的话第二个请求就只剩令牌，会拿到 401，看着像功能坏了，其实是测法错了。
# 所以这里严格按浏览器的顺序来：先开页面让 _open_project_session 落进 cookie jar，
# 再带着会话调接口。
#
# 用法：smoke-handoff.sh [项目标识]   默认 eva-project
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

project_root="${EVAPROJECT_LOCAL_SOURCE:-${0:A:h:h:h}}"
local_root="${EVAPROJECT_LOCAL_ROOT:-/Users/Shared/Eva-Project-local}"
env_file="$local_root/runtime/.env"
web_port="${EVAPROJECT_LOCAL_WEB_PORT:-28080}"
base="http://localhost:$web_port"
identifier="${1:-eva-project}"
export DOCKER_CONTEXT="colima-evaproject-local"

grep -q '192\.168\.80\.4' "$env_file" && { print -u2 -- "拒绝：目标不是本地实例"; exit 1; }

compose() {
  docker-compose --project-name eva-project-local --env-file "$env_file" \
    -f "$project_root/vendor/openproject-docker-compose/docker-compose.yml" \
    -f "$project_root/deploy/docker-compose.override.yml" "$@"
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
jar="$work/jar"
failures=0

check() {  # check <说明> <路径> <期望码> [正文必须含有的字符串]
  # 别把局部变量叫 path：zsh 里它绑定 $PATH，一赋值整个函数就找不到命令了。
  local label="$1" route="$2" want="$3" needle="${4:-}"
  local code
  code="$(curl -s -o "$work/body" -w '%{http_code}' -b "$jar" -c "$jar" "$base$route")"
  if [ "$code" != "$want" ]; then
    printf '  ✗ %-34s %s  期望 %s\n' "$label" "$code" "$want"
    printf '      %s\n' "$(tr -d '\n' < "$work/body" | tr -s ' ' | head -c 160)"
    failures=$((failures + 1))
    return 0
  fi
  # 整份正文都要查。OpenProject 的页面有 80KB 以上，截断了 grep 会把注入的资源漏掉。
  if [ -n "$needle" ] && ! grep -q -- "$needle" "$work/body"; then
    printf '  ✗ %-34s %s  但正文里没有「%s」\n' "$label" "$code" "$needle"
    failures=$((failures + 1))
    return 0
  fi
  printf '  ✓ %-34s %s\n' "$label" "$code"
}

token_json="$(compose exec -T web bundle exec rails runner - < "$project_root/deploy/dev/autologin.rb" 2>/dev/null)"
cookie_name="$(print -r -- "$token_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["cookie_name"])')"
cookie_value="$(print -r -- "$token_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')"
printf '#HttpOnly_localhost\tFALSE\t/\tFALSE\t0\t%s\t%s\n' "$cookie_name" "$cookie_value" > "$jar"
unset token_json cookie_value

print -r -- "带真实会话点一遍（项目：$identifier）"
# 第一跳把 HTML 会话换出来，后面的接口调用才是浏览器的真实行为。
check "全局交接页" "/handoff" 200 "handoff.js"
check "全局交接页含菜单项" "/handoff" 200 "上下文交接"
check "项目内交接页" "/projects/$identifier/handoff" 200 "handoff.js"
check "会话接口" "/handoff/api/session" 200 '"userId"'
check "交接列表接口" "/handoff/api/handoffs" 200 '"items"'
check "按项目筛选" "/handoff/api/handoffs?project=$identifier" 200 '"items"'
check "项目内会话接口" "/projects/$identifier/handoff/api/session" 200 '"userId"'
# 菜单项注册错了会让原生工作包列表整页 500，所以它必须一起测。
check "原生工作包列表未被拖垮" "/work_packages" 200
check "项目内工作包列表" "/projects/$identifier/work_packages" 200

print -r -- ""
print -r -- "菜单渲染探针（注册成功不等于会显示）"
# 探针跑不起来本身就是失败，但不该让脚本无声猝死——汇总行必须打得出来。
if ! probe="$(compose exec -T -e EVAPROJECT_PROBE_PROJECT="$identifier" \
  web bundle exec rails runner - < "$project_root/deploy/dev/menu-probe.rb" 2>&1)"; then
  printf '  ✗ 菜单探针执行失败：%s\n' "$(print -r -- "$probe" | tr -d '\n' | tr -s ' ' | head -c 200)"
  failures=$((failures + 1))
  probe=""
fi
[ -n "$probe" ] && print -r -- "$probe" | python3 -c '
import json, sys
data = json.load(sys.stdin)
bad = 0
for menu in ("project_menu", "global_menu"):
    info = data[menu]
    ok = bool(info["handoff_visible"]) and bool(info["handoff_href"])
    print("  %s %-32s 可见=%s href=%s" % ("\u2713" if ok else "\u2717", menu, info["handoff_visible"], info["handoff_href"]))
    bad += 0 if ok else 1
filters = data["default_query_filters"]
excluded = any("type" in item for item in filters)
print("  %s %-32s %s" % ("\u2713" if excluded else "\u2717", "默认查询排除交接类型", filters))
bad += 0 if excluded else 1
sys.exit(1 if bad else 0)
' || failures=$((failures + 1))

print -r -- ""
if [ "$failures" -ne 0 ]; then
  print -u2 -- "✗ $failures 项没通过。"
  exit 1
fi
print -r -- "✓ 全部通过：页面能开、接口能答、菜单真的显示、原生列表没被拖垮。"
