# frozen_string_literal: true
require "fileutils"
require "securerandom"
require "json"
root, host = ARGV
abort "usage: ruby home_env.rb EVA_ROOT HOST" unless root && host
abort "Eva root must end with /Eva-Project" unless File.basename(root) == "Eva-Project"
abort "Use an IPv4 host address" unless host.match?(/\A\d{1,3}(\.\d{1,3}){3}\z/)
runtime = File.join(root, "runtime")
FileUtils.mkdir_p([File.join(runtime, "logs"), File.join(runtime, "mcp"), File.join(root, "data", "postgres"), File.join(root, "data", "openproject", "assets"), File.join(root, "backup")])
File.chmod(0700, runtime)
File.chmod(0700, File.join(runtime, "mcp"))
env_path = File.join(runtime, ".env")
if File.exist?(env_path)
  puts "Existing Eva configuration retained"
  exit
end
admin_password = SecureRandom.hex(20) + "aA1!"
postgres_password = SecureRandom.hex(32)
mcp_token = SecureRandom.hex(32)
values = {
  "TAG" => "17.8.0-slim", "POSTGRES_VERSION" => "17",
  "OPENPROJECT_HTTPS" => "false", "OPENPROJECT_HSTS" => "false",
  "OPENPROJECT_HOST__NAME" => "#{host}:28080",
  "OPENPROJECT_ADDITIONAL__HOST__NAMES" => ["web", "localhost", "127.0.0.1", host].to_json,
  "OPENPROJECT_DEFAULT__LANGUAGE" => "zh-CN",
  "OPENPROJECT_SEED__ADMIN__USER__PASSWORD" => admin_password,
  "OPENPROJECT_SEED__ADMIN__USER__PASSWORD__RESET" => "false",
  "OPENPROJECT_SEED__ADMIN__USER__NAME" => "哥 头",
  "OPENPROJECT_SEED__ADMIN__USER__MAIL" => "admin@eva-project.local",
  "PORT" => "#{host}:28080", "MCP_PORT" => "28081", "MCP_BIND_ADDRESS" => host,
  "MCP_ALLOWED_HOSTS" => "localhost,127.0.0.1,mcp,#{host}",
  "SECRET_KEY_BASE" => SecureRandom.hex(64), "POSTGRES_PASSWORD" => postgres_password,
  "DATABASE_URL" => "postgres://postgres:#{postgres_password}@db/openproject?pool=20&encoding=unicode&reconnect=true",
  "COLLABORATIVE_SERVER_URL" => "ws://#{host}:28080/hocuspocus",
  "COLLABORATIVE_SERVER_SECRET" => SecureRandom.hex(32),
  "OPENPROJECT_API_TOKEN" => "PENDING_BOOTSTRAP",
  "OPENPROJECT_PUBLIC_URL" => "http://#{host}:28080",
  "EVAPROJECT_MCP_PUBLIC_URL" => "http://#{host}:28081/mcp",
  "EVAPROJECT_ADMIN_URL" => "http://#{host}:28081/admin/",
  "EVAPROJECT_ROOT" => File.join(root, "current"), "EVAPROJECT_RUNTIME" => runtime,
  "EVAPROJECT_BACKUP" => File.join(root, "backup"),
  "PGDATA" => File.join(root, "data", "postgres"), "OPDATA" => File.join(root, "data", "openproject", "assets"),
  "EVAPROJECT_UID" => Process.uid.to_s, "EVAPROJECT_GID" => Process.gid.to_s,
  "EVAPROJECT_TZ" => "Asia/Hong_Kong", "RAILS_MIN_THREADS" => "2", "RAILS_MAX_THREADS" => "8", "IMAP_ENABLED" => "false"
}
File.open(env_path, File::WRONLY | File::CREAT | File::EXCL, 0600) { |f| f.write(values.map { |k, v| "#{k}=#{v}" }.join("\n") + "\n") }
File.open(File.join(runtime, "admin-password"), "w", 0600) { |f| f.write(admin_password + "\n") }
File.open(File.join(runtime, "mcp", "principals.json"), "w", 0600) { |f| f.write(JSON.pretty_generate({ principals: [{ token: mcp_token, userId: "admin", displayName: "头哥", openProjectLogin: "admin", role: "admin", active: true }] }) + "\n") }
puts "Independent Eva runtime configuration created; credentials remain in runtime/"
