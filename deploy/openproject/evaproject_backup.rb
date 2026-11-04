# frozen_string_literal: true

# The backup page (#237), from inside OpenProject.
#
# Brian 2026-09-24: backups were a host script and a launchd job to be installed over SSH
# with sudo. He wanted them to be part of this system — switched on, timed, looked at and
# restored on a page. The MCP keeps the schedule and does the work; this page is where an
# administrator sees and drives it.
#
# Same shape as the user management page (evaproject_tokens.rb): OpenProject renders the
# chrome, this renders the body, and the JSON API stays in the MCP behind a proxy that
# forwards the session cookie, so admin access is decided the one way it already is. A
# download is the one answer that is not JSON; it is passed on as it arrives, because a
# backup can be far larger than anything worth holding in memory.

require "net/http"

EVAPROJECT_BACKUP_MCP_URL = ENV.fetch("EVAPROJECT_MCP_INTERNAL_URL", "http://mcp:8081")

Rails.application.config.to_prepare do
  next if Object.const_defined?(:EvaprojectBackupController)

  controller = Class.new(::ApplicationController) do
    before_action :require_admin

    # Instance administration is not a project permission; `require_admin` above is the
    # check, and saying so keeps the authorization callback from raising.
    no_authorization_required! :index, :api, :download

    def index
      body = <<~HTML
        <div id="mp-backup" class="mp-backup" data-api="/backups/api" data-download="/backups/download"></div>
      HTML
      render html: body.html_safe, layout: "global"
    end

    def api
      target = URI.join(EVAPROJECT_BACKUP_MCP_URL, "/backup/api/#{params[:rest]}")
      proxied = proxy_request(target)
      render json: proxied.body, status: proxied.code.to_i
    rescue StandardError => e
      Rails.logger.error("Eva-Project backup proxy failed: #{e.class}: #{e.message}")
      render json: { error: "无法连接备份服务，请稍后重试" }, status: :bad_gateway
    end

    # Asked first with an ordinary request, so a backup that is gone, or a session the
    # MCP refuses, answers as an error rather than as a file named like a backup.
    def download
      kind = params[:kind].to_s
      name = params[:name].to_s
      return head(:not_found) unless %w[daily release].include?(kind) && name.match?(/\A\d{8}-\d{6}\z/)

      check = proxy_request(URI.join(EVAPROJECT_BACKUP_MCP_URL, "/backup/api/backups/#{kind}/#{name}"))
      return render(json: check.body, status: check.code.to_i) unless check.is_a?(Net::HTTPSuccess)

      target = URI.join(EVAPROJECT_BACKUP_MCP_URL, "/backup/api/backups/#{kind}/#{name}/download")
      cookie = request.headers["Cookie"].to_s
      response.headers["Content-Type"] = "application/x-tar"
      response.headers["Content-Disposition"] = %(attachment; filename="eva-project-backup-#{name}.tar")
      response.headers["Cache-Control"] = "no-store"
      # Without these, Rack::ETag or a proxy in front would hold the whole body to
      # fingerprint or buffer it before sending the first byte.
      response.headers["Last-Modified"] = Time.now.httpdate
      response.headers["X-Accel-Buffering"] = "no"
      self.response_body = Enumerator.new do |out|
        Net::HTTP.start(target.host, target.port, open_timeout: 5, read_timeout: 60) do |http|
          outbound = Net::HTTP::Get.new(target)
          outbound["Cookie"] = cookie
          http.request(outbound) { |upstream| upstream.read_body { |chunk| out << chunk } }
        end
      end
    rescue StandardError => e
      Rails.logger.error("Eva-Project backup download failed: #{e.class}: #{e.message}")
      render json: { error: "无法连接备份服务，请稍后重试" }, status: :bad_gateway
    end

    private

    def proxy_request(target)
      klass = request.post? ? Net::HTTP::Post : Net::HTTP::Get
      outbound = klass.new(target)
      outbound["Cookie"] = request.headers["Cookie"].to_s
      outbound["Content-Type"] = "application/json"
      # The MCP checks the request origin on writes; it sees this proxy, not the browser.
      outbound["Origin"] = "#{target.scheme}://#{target.host}:#{target.port}"
      outbound.body = request.post? ? (request.raw_post.presence || "{}") : nil

      Net::HTTP.start(target.host, target.port, read_timeout: 20, open_timeout: 5) do |http|
        http.request(outbound)
      end
    end
  end

  Object.const_set(:EvaprojectBackupController, controller)
end

Rails.application.config.after_initialize do
  Rails.application.routes.append do
    get "/backups", to: "evaproject_backup#index", as: :evaproject_backups
    match "/backups/api/*rest", to: "evaproject_backup#api", via: %i[get post]
    get "/backups/download/:kind/:name", to: "evaproject_backup#download", as: :evaproject_backup_download
  end
  Rails.application.reload_routes!
end
