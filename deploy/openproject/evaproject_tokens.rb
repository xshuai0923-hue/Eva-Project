# frozen_string_literal: true

# Serves MCP user and token management from inside OpenProject.
#
# It was the last page still standing outside: its own HTML, its own palette and its own
# header, served straight off the MCP port. That is the arrangement the handoff and
# requirement modules were moved out of, for the reason given there — a page with its own
# chrome is a second system, and it drifts from this one every time the theme changes.
#
# Same shape as those two: OpenProject renders the chrome, this renders the body, and the
# JSON API stays in the MCP, reached through a proxy that forwards the browser's session
# cookie. The MCP already decides admin access from that cookie (`openProjectAdminAccess`),
# so there is exactly one identity path rather than a second one invented here.

require "net/http"

EVAPROJECT_TOKENS_MCP_URL = ENV.fetch("EVAPROJECT_MCP_INTERNAL_URL", "http://mcp:8081")

Rails.application.config.to_prepare do
  next if Object.const_defined?(:EvaprojectTokensController)

  controller = Class.new(::ApplicationController) do
    before_action :require_admin

    # Instance administration is not a project permission, so there is nothing for
    # `do_authorize` to map these actions onto. `require_admin` above is the check; saying
    # so here keeps the authorization callback from raising on a page that is guarded.
    no_authorization_required! :index, :api

    def index
      body = <<~HTML
        <div id="mp-tokens" class="mp-tokens" data-api="/mcp-tokens/api"></div>
      HTML
      render html: body.html_safe, layout: "global"
    end

    def api
      target = URI.join(EVAPROJECT_TOKENS_MCP_URL, "/admin/api/#{params[:rest]}")
      proxied = proxy_request(target)
      render json: proxied.body, status: proxied.code.to_i
    rescue StandardError => e
      Rails.logger.error("Eva-Project tokens proxy failed: #{e.class}: #{e.message}")
      render json: { error: "无法连接 MCP 服务，请稍后重试" }, status: :bad_gateway
    end

    private

    def proxy_request(target)
      klass = request.post? ? Net::HTTP::Post : Net::HTTP::Get
      outbound = klass.new(target)
      outbound["Cookie"] = request.headers["Cookie"].to_s
      outbound["Content-Type"] = "application/json"
      outbound["Origin"] = "#{target.scheme}://#{target.host}:#{target.port}"
      outbound.body = request.post? ? (request.raw_post.presence || "{}") : nil

      Net::HTTP.start(target.host, target.port, read_timeout: 20, open_timeout: 5) do |http|
        http.request(outbound)
      end
    end
  end

  Object.const_set(:EvaprojectTokensController, controller)
end

Rails.application.config.after_initialize do
  Rails.application.routes.append do
    get "/mcp-tokens", to: "evaproject_tokens#index", as: :evaproject_tokens
    match "/mcp-tokens/api/*rest", to: "evaproject_tokens#api", via: %i[get post]
  end
  Rails.application.reload_routes!
end
