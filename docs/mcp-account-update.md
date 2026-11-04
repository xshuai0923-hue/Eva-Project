# MCP 账号关联与密码规则更新（2026-10-09）

本次功能已在本地开发实例验证。实际源码版本以发布包内 `release-manifest.json` 的 Git 提交为准；没有本次远端部署或部署验收记录。完整变更及新服务器交接事项见 [发布说明](releases/2026-10-09.md)。

## 页面使用

管理员进入「MCP 用户」：

- 新增用户必须选择一个已启用的网页账号，选项同时显示姓名和精确登录名。
- 已有用户点击「关联账号」或「编辑关联」，选择账号并保存。原 MCP ID、Token、角色和启用状态保留。
- 「解除关联」只移除映射，保留原 Token；普通身份在重新关联前无法解析网页账号或读取项目。
- 一个网页账号只能关联一个 MCP 身份。被吊销的身份仍保留关联，需先解除关联才能分配给另一身份。
- 管理员 MCP 身份只能关联网页管理员账号，页面不允许解除管理员关联。

服务器上的 `liduoji` 应选择登录名 **李多吉**，保存后刷新网页，再重新配对客户端并核对身份和项目。不要创建 `liduoji1` 来代替这一步；若另一个身份占用此账号，先确认正确身份并解除错误关联。

网页密码统一为：**至少 8 位，同时包含英文字母和数字，字母大小写均可**。允许其他字符，但不要求大写、小写同时出现或特殊字符。创建、改密和密码恢复共用服务器校验；已有密码不会被重置。

## 兼容与 API

旧配置不填写 `openProjectLogin` 时仍按 `userId` 精确匹配。解除关联保存为 `openProjectLogin: null`，明确禁止该回退。

所有管理接口继续要求网页管理员会话，写请求校验来源；网页代理继续使用 Rails CSRF 校验。新增接口：

| 操作 | 请求 |
| --- | --- |
| 网页账号候选列表 | `GET /admin/api/accounts`，返回已启用账号的 ID、登录名、显示名称和管理员标识，不返回邮箱、凭据 |
| 创建身份 | `POST /admin/api/users`，增加必填 `openProjectLogin` 字符串 |
| 编辑/解除关联 | `POST /admin/api/users/:userId/link`，包含 `openProjectLogin`（字符串或 null）及 `lockVersion` |

`GET /admin/api/users` 返回不包含 Token 的身份摘要和不透明字符串 `lockVersion`。编辑须原样提交版本；配置改变后旧版本返回 HTTP 409，不覆盖或自动重试。Token 明文仍只在创建、轮换时返回。关联修改以私有文件原子替换保存，后续请求读取新映射。

## 既有 macOS 实例升级（历史环境参考）

下列示例基于历史联调环境 `brian@192.168.80.4`，根目录 `/Users/Shared/Eva-Project`，Colima `evaproject`，Compose `eva-project`。它不代表已确认的新服务器目标。仅在核对现有实例与当次部署授权后适用；不执行初始化、数据库迁移或重新引导。Linux 或全新实例须使用部署准备文档的相应流程。

本次发布包包含对应提交的源码及固定子模块，不包含 `.git`、本地依赖、运行配置、凭据或演示数据。使用与交接清单一致的包名和 SHA-256；之前的 `eva-accounts-20261009.tar.gz` 是旧预览包，不包含私有项目创建者权限修复，不用于本次发布。

1. 在现有网页「备份与恢复」完成一次完整备份，确认成功。升级期间暂停账号编辑和 Token 轮换，记录当前 release。
2. 把压缩包及同目录的 `.sha256` 文件复制到服务器，例如：

```bash
eva_package='<本次发布包文件名>.tar.gz'
scp "$eva_package" "$eva_package.sha256" brian@192.168.80.4:/tmp/
ssh brian@192.168.80.4
eva_package='<本次发布包文件名>.tar.gz'
cd /tmp
shasum -a 256 -c "$eva_package.sha256"
```

3. 在服务器建立新 release 和私有配置备份：

```bash
umask 077
export PATH="/opt/homebrew/bin:$PATH"
export DOCKER_CONTEXT=colima-evaproject
eva_root=/Users/Shared/Eva-Project
release_tag=eva-project-20261009-r1
release_dir="$eva_root/releases/$release_tag"
rollback_dir="$eva_root/backup/upgrade-$release_tag"
test -L "$eva_root/current"
test ! -e "$release_dir"
test ! -e "$rollback_dir"
mkdir -p "$release_dir" "$rollback_dir"
readlink "$eva_root/current" > "$rollback_dir/previous-release"
cp "$eva_root/runtime/mcp/principals.json" "$rollback_dir/principals.json"
chmod 600 "$rollback_dir/principals.json"
docker image tag "$(docker inspect --format '{{.Image}}' eva-project-mcp-1)" "eva-project/openproject-mcp:rollback-$release_tag"
tar -xzf "/tmp/$eva_package" --strip-components=1 -C "$release_dir"
```

4. **先构建 MCP，再切换 release 并重新创建应用容器。** `evaproject-home up` 使用 `--no-build`，只执行它会继续使用旧 MCP 镜像。重建 Web 才会加载新密码初始化文件和资源引用。

```bash
export EVAPROJECT_ROOT="$release_dir"
eva_compose() {
  docker-compose --project-name eva-project \
    --env-file "$eva_root/runtime/.env" \
    -f "$release_dir/vendor/openproject-docker-compose/docker-compose.yml" \
    -f "$release_dir/deploy/docker-compose.override.yml" \
    -f "$release_dir/deploy/docker-compose.home.yml" "$@"
}
eva_compose config --quiet
eva_compose build mcp
ln -s "$release_dir" "$eva_root/current.next"
ruby -e 'File.rename(ARGV.fetch(0), ARGV.fetch(1))' "$eva_root/current.next" "$eva_root/current"
eva_compose up -d --no-deps --force-recreate web worker cron mcp
eva_compose ps
curl --fail --retry 20 --retry-delay 3 --retry-all-errors http://127.0.0.1:28080/health_checks/default
curl --fail http://127.0.0.1:28081/healthz
eva_compose exec -T web bundle exec rails runner - < "$release_dir/deploy/openproject/password-policy.test.rb"
```

密码测试只构建未保存的 User 对象，不改动服务器用户或密码。不要在服务器运行 `autologin.rb` 或 `smoke-mcp-accounts.mjs`，这些仅用于本地测试。

5. 管理员登录，确认 MCP 页面能加载「关联网页账号」，然后修复已有 `liduoji → 李多吉`。检查 Token 指纹和角色未改变。用普通用户重新配对并验证项目权限；在真实客户端完成验收。创建新身份时检查必选账号，重复关联不能保存。确认后恢复账号管理操作。

没有运行本次 bootstrap，没有更换 OpenProject 镜像、数据库结构或现有密码。已有部署的 seeder 无需启动；首次部署时 seeder 会自动加载同一密码规则。

## 回滚

若第 4 步的健康检查或页面验证失败，**先保持暂停账号编辑**，恢复原 release 和原 MCP 镜像：

```bash
saved_release="$(cat "$rollback_dir/previous-release")"
case "$saved_release" in
  /*) rollback_release="$saved_release" ;;
  *) rollback_release="$eva_root/$saved_release" ;;
esac
eva_compose stop mcp
docker image tag "eva-project/openproject-mcp:rollback-$release_tag" eva-project/openproject-mcp:0.2.0
ln -s "$rollback_release" "$eva_root/current.rollback"
ruby -e 'File.rename(ARGV.fetch(0), ARGV.fetch(1))' "$eva_root/current.rollback" "$eva_root/current"
export EVAPROJECT_ROOT="$rollback_release"
release_dir="$rollback_release"
```

此时 MCP 仍保持停止。旧版本不支持 `openProjectLogin: null`。若验收期间已经使用「解除关联」，启动旧程序前还需恢复私有 `principals.json` 备份；**仅在升级后未新增用户、未轮换或吊销 Token 的情况下恢复**，否则会撤销这些变化，必须先由管理员核对处理。保存当前文件供恢复，再原子替换：

```bash
cp "$eva_root/runtime/mcp/principals.json" "$rollback_dir/principals-before-rollback.json"
cp "$rollback_dir/principals.json" "$eva_root/runtime/mcp/principals.rollback.json"
chmod 600 "$eva_root/runtime/mcp/principals.rollback.json"
mv -f "$eva_root/runtime/mcp/principals.rollback.json" "$eva_root/runtime/mcp/principals.json"
```

配置兼容后，启动原版本应用并重新检查健康状态：

```bash
eva_compose up -d --no-deps --force-recreate web worker cron mcp
eva_compose ps
```

配置备份包含凭据，只保存在服务器私有目录，不上传、打印或加入 Git。

## 本地验证记录

- MCP TypeScript 检查、321 项测试及构建通过；网页模块 121 项测试通过。
- 容器中真实密码 Evaluator/User 校验的 11 组案例和中文提示通过；本地演示账号分别用随机生成的 8 位小写/大写字母数字密码保存成功。
- 实际 HTTP/MCP 验证：管理员/普通用户/匿名鉴权、写请求来源、创建/修改/解除、重复与缺失账号、409 冲突、管理员角色保护、原 Token 保留且解除后项目访问失败、重新关联后恢复。
- 配置保存失败时保留原内存映射；解除关联后重启 MCP，显式空值能重新加载，恢复关联后 Token 指纹和角色保持一致。
- Chrome 页面确认：关联列表、新增必选下拉框、被占用账号禁选、已有身份保存成功、实际密码字段提示。演示用户和数据仅在本地。
- 真实远端部署及另一台设备的客户端验收尚未执行。当前会话没有可用的内部 M-Project 工具，需求认领与交接登记尚未写入内部项目 9。
