# 验证工具

MCP 账号关联的本地验证使用 `smoke-mcp-accounts.mjs <管理员 jar> <普通用户 jar>`。
只连接固定本机 28081，要求本地已有登录名 `李多吉` 和 `preview-member` 的演示网页账号，
并创建 `liduoji`、`preview-new` 演示 MCP 身份。它会测试关联写入及解除，**不能用于生产**；
凭据只在进程内使用，不输出 Token。运行一次后保留演示数据供页面检查，重复执行应先用新的隔离实例。
密码的只读校验：`... exec -T web bundle exec rails runner - < deploy/openproject/password-policy.test.rb`。
该测试不保存用户或修改密码，可以对升级后的实例执行。

私有项目创建权限验证使用 `smoke-project-creation.mjs <管理员 jar> <创建者 jar> <其他用户 jar> [新项目标识]`。
需要专用本地账号 `project-creator-demo`（子芸 本地验证）和 `project-outsider-demo`，只访问 localhost。
脚本创建或轮换自己的演示 MCP 身份，并创建私有项目、需求与工作包；核对默认成员角色、网页/MCP 访问和其他用户隔离。
`--reuse-fixture` 作为最后一个参数时继续核对自己的演示项目；**不能用于生产**。验证结束应吊销演示 Token 并清理临时会话。

分两类，**不要混用**：

| 脚本 | 会不会写数据 | 能不能对生产跑 |
| --- | --- | --- |
| `state-snapshot.rb` | 只读 | **能**。升级前后各取一份 |
| `state-diff.py` | 只读本地 JSON | **能**。它只读两份快照文件 |
| `menu-probe.rb` | 只读 | 能，但一般没必要 |
| `autologin.rb` | **写**（签发令牌、改 Setting） | **不能** |
| `smoke-handoff.sh` | 依赖 autologin，**写** | **不能** |
| `smoke-browser.sh` | 依赖 autologin，**写**（结束时作废令牌） | **不能** |
| `session-proxy.mjs` | 只读本地 cookie jar | **不能**，只接受本机实例 |

本机测试实例由 `deploy/bin/evaproject-local` 管理；演练由 `deploy/bin/evaproject-rehearse` 驱动。

## 别用宿主机的 `ruby -c` 检查这些脚本

宿主机是 Ruby 2.6，容器里是 Ruby 4.0。`menu-probe.rb` 用了端点方法定义
（`def controller.action_name = "index"`，Ruby 3.0+），宿主机上 `ruby -c` 会报
syntax error，而它在容器里完全正常。要检就在容器里检：

```bash
... exec -T web ruby -c < deploy/dev/state-snapshot.rb
```

## 升级对账：快照 + 对账器

**数工作包数不出数据丢失。** 某个自定义字段的已填值被清掉一半，工作包一条不少，肉眼验收
一路绿灯。所以快照除了条数，还记录每个字段实际填了值的工作包数，以及一份覆盖全部工作包
行的摘要。

```bash
# 升级前后各取一份（只读，生产也能跑）
compose exec -T web bundle exec rails runner - < deploy/dev/state-snapshot.rb > before.json
compose exec -T web bundle exec rails runner - < deploy/dev/state-snapshot.rb > after.json

python3 deploy/dev/state-diff.py before.json after.json
```

对账器编码的是 `docs/handoff-production-upgrade.md` 里"全部是追加性改动"那张表：

- **预期内**：新增 `交接` 类型、9 个交接字段、10 处共用字段追加绑定、两个枚举追加 `Mila`。
- **算违约**：任何既有类型/字段/项目/用户/状态/查询消失或降级，任何字段的 id、格式、
  类型绑定、选项顺序发生变化，任何字段的已填值减少，工作包或附件内容变化，欢迎页被覆盖
  （这条是引导脚本"首次运行判定"失效的典型症状）。
- **该做没做**：交接类型缺失或没有工作流（状态变更会一律 422）、交接字段绑到了需求类型上
  （会污染需求表单）、共用字段漏绑交接、枚举漏加 `Mila`。

退出码 0 才算过。只有升级后快照时可以只传一个参数，但那样只能校验"该做的做了没有"。

## 演练一次升级

```bash
EVAPROJECT_REHEARSE_CONFIRM=restore deploy/bin/evaproject-rehearse run 生产转储.dump [assets.tar.gz]
```

恢复转储 → 前快照 → 跑引导并计时 → 校验 `first_run=false` → 后快照 → 对账 → 冒烟。
任一步不过就退出非零。产物留在 `/Users/Shared/Eva-Project-local/rehearsal/<时间戳>/`。

只想取一份快照而不演练：`deploy/bin/evaproject-rehearse snapshot 输出.json`。

不提供附件包时，附件的数据库记录在、文件不在。数据对账不受影响，但点开附件会 404。

## 免密登录浏览器会话

Agent 不能输入密码。用 OpenProject 自己的自动登录令牌取得会话：

```bash
docker-compose --project-name eva-project-local \
  --env-file /Users/Shared/Eva-Project-local/runtime/.env \
  -f vendor/openproject-docker-compose/docker-compose.yml \
  -f deploy/docker-compose.override.yml \
  exec -T web bundle exec rails runner - < deploy/dev/autologin.rb
```

把返回的 `value` 作为 `autologin` cookie 写进浏览器即可。

**用 curl 测的时候必须带 cookie jar。** 自动登录令牌只换得来 HTML 会话，API v3 不认它。
不存 cookie 的话第二个请求只剩令牌，会拿到 401，看着像接口坏了，其实是测法错了：

```bash
curl -b jar -c jar http://localhost:28080/handoff            # 第一跳：换出会话
curl -b jar -c jar http://localhost:28080/handoff/api/session # 第二跳：这才是浏览器的行为
```

## 功能冒烟

```bash
deploy/dev/smoke-handoff.sh [项目标识]
```

带真实登录态把交接页、项目内交接页、三个接口、原生工作包列表逐条点一遍，再跑菜单探针。
**原生工作包列表也在里面**：菜单项注册错了会让它整页 500，不测就发现不了。

## 浏览器冒烟：Chrome 与 Safari 同款引擎各跑一遍

```bash
deploy/dev/smoke-browser.sh [搜索词]              # 默认「分页」
EVAPROJECT_SMOKE_ONLY=webkit deploy/dev/smoke-browser.sh   # 只跑一个引擎：chrome 或 webkit
```

同一套步骤（`smoke/scenarios.mjs`）在无头 Chrome（`smoke/chrome.mjs`，DevTools 协议）和
WKWebView（`smoke/webkit.swift`，Safari 用的 WebKit，临时编译）各跑一遍，鼠标和按键都是真实
事件：顶栏搜索的鼠标首次点击、输入法选字期间不出结果且确认后一次点开、上下键加回车、没选中时
回车进结果页、结果页翻页，需求池和交接页按链接打开指定的一条，以及备份页的恢复确认（打出备份名
才能点，选字期间也不行；只点到取消，不真的恢复）。任一项不过退出码非 0，失败行带上当时的页面状态。

另有三个手机场景（`viewport` 步骤把窗口换成 390×844，每个场景开始时回到宽屏）：需求和交接的
详情盖住整屏、「返回列表」回到原页面原位置（页面没被重画），以及主题筛选在选字期间不搜、上屏后
输入框和光标都还在。

iPhone 独有的问题（比如 Safari 把会滚动的盒子画成单独的图层，见 `docs/requirements-gui.md` 的
「手机」一节）这两个引擎测不出来，要在 iOS 模拟器的 Safari 里看：`session-proxy.mjs` 起着的时候，
模拟器和本机共用网络，`xcrun simctl openurl <设备> http://127.0.0.1:28090/…` 直接打开，
`xcrun simctl io <设备> screenshot 文件.png` 截图。用一台没人在用的模拟器，别占别的项目开着的那台。

**为什么要有 WebKit 这一遍**：#218 上线后，Safari 里用拼音输入法要点两次才能打开搜索结果，只在
Chrome 里点是发现不了的。真实输入法「把第一次点击拿去确认文字」这一步模拟不了；这里模拟的是
输入法持有文字（`setMarkedText`）再确认，验证选字期间不出可点的结果。

**浏览器碰不到令牌**：autologin 令牌只用来让 curl 换出会话；会话由只监听 127.0.0.1 的
`session-proxy.mjs` 持有，浏览器只连它。令牌和 cookie 只放临时目录，结束时删掉目录并作废这次签
的令牌。WebKit 的窗口放在屏幕外、程序不激活，不会抢走正在用这台机器的人的键盘；窗口是无边框
的、不会成为主窗口——能成为主窗口的话，第一下点击会被拿去激活窗口，到不了网页。

## 菜单渲染探针

**注册成功不等于会显示。** 菜单项还要过 `allowed_node?`、`visible_node?` 和图标渲染，
任一失败会静默隐藏或整页 500。加任何菜单项后都跑一次：

```bash
... exec -T web bundle exec rails runner - < deploy/dev/menu-probe.rb
```

顺带查默认查询的筛选条，确认 `type_id !`（排除交接类型）还在。

## 改挂载进容器的那两个 .rb 之后要重建容器

`evaproject_navigation.rb` 和 `evaproject_handoff.rb` 是**单文件** bind mount。macOS 的
`sed -i ''` 是写临时文件再改名覆盖，**换掉 inode**；单文件挂载绑的是旧 inode，改名后
它被 unlink，挂载就悬空了。

症状极具迷惑性：容器里 `ls` 还能看到目录项、大小也对，但 `open` 返回
`No such file`。已经在跑的 Puma 因为启动时加载过，照常服务，健康检查全绿；只有**新进程**
会炸，例如：

```
rails runner: cannot load such file -- /app/config/initializers/evaproject_navigation.rb (LoadError)
```

改完这两个文件后重建 web 容器即可（本机实例 `deploy/bin/evaproject-local` 起的那套同理）。

**更省事的办法是别换 inode**：`deploy/dev/edit-mounted.py <文件> <旧串> <新串>` 以 `r+`
打开再截断，inode 不变，容器立刻读到新内容，不必重建。
资源版本号不用手改：`node deploy/openproject/asset-versions.mjs stamp` 按内容哈希重写全部
`?v=`，同样就地写、不换 inode；`check` 只查不写，前端测试里也跑它，漏跑 `stamp` 测试就红。
`deploy/openproject/assets` 是**目录**挂载，不受影响——css/js 怎么改都能立刻生效，
所以只有 `.rb` 会中招。

正式环境不会碰到：那边是 rsync 一份新 release 目录再翻符号链接，容器本来就要重建。
