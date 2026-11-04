# frozen_string_literal: true

# Serves the requirement pool from inside OpenProject.
#
# Same arrangement as the handoff module, for the same reasons: OpenProject renders the
# top bar, the menus and the theme, and this controller proxies the JSON API to the MCP
# with the browser's session cookie attached, so identity and per-record visibility are
# decided by exactly the code that answers an agent. See `evaproject_handoff.rb` for the
# six ways this goes wrong; none of them are re-explained here.
#
# The native work package list stays available as the audit and fallback view — change
# history, comments, attachments, search and export all live there.

require "net/http"

EVAPROJECT_REQUIREMENTS_MCP_URL = ENV.fetch("EVAPROJECT_MCP_INTERNAL_URL", "http://mcp:8081")

Rails.application.config.to_prepare do
  unless OpenProject::AccessControl.permission(:view_evaproject_requirements)
    OpenProject::AccessControl.map do |map|
      map.permission :view_evaproject_requirements,
                     { evaproject_requirements: %i[index api] },
                     permissible_on: :project,
                     public: true
    end
  end

  next if Object.const_defined?(:EvaprojectRequirementsController)

  controller = Class.new(::ApplicationController) do
    before_action :find_optional_project
    before_action :require_login

    # Which requirements a person may see is decided per record by the MCP from their
    # identity, not by a project permission, so this controller carries no check of its
    # own and says so rather than letting `do_authorize` raise.
    no_authorization_required! :index, :api

    def index
      scope = @project ? "/projects/#{CGI.escape(@project.identifier)}/requirements" : "/requirements"
      body = <<~HTML
        <div id="mp-requirements" class="mp-requirements"
             data-api="#{ERB::Util.html_escape(scope)}/api"
             data-project="#{ERB::Util.html_escape(@project&.identifier)}"></div>
      HTML
      render html: body.html_safe, layout: @project ? "base" : "global"
    end

    def api
      target = URI.join(EVAPROJECT_REQUIREMENTS_MCP_URL, "/requirements/api/#{params[:rest]}")
      query = request.query_parameters.except("rest", "project_id")
      query["project"] ||= @project.identifier if @project
      target.query = query.to_query if query.any?

      proxied = proxy_request(target)
      render json: proxied.body, status: proxied.code.to_i
    rescue StandardError => e
      Rails.logger.error("Eva-Project requirements proxy failed: #{e.class}: #{e.message}")
      render json: { error: "无法连接需求服务，请稍后重试" }, status: :bad_gateway
    end

    private

    def proxy_request(target)
      klass = request.post? ? Net::HTTP::Post : Net::HTTP::Get
      outbound = klass.new(target)
      outbound["Cookie"] = request.headers["Cookie"].to_s
      outbound["Content-Type"] = "application/json"
      outbound["Origin"] = "#{target.scheme}://#{target.host}:#{target.port}"
      outbound.body = request.raw_post if request.post?

      Net::HTTP.start(target.host, target.port, read_timeout: 20, open_timeout: 5) do |http|
        http.request(outbound)
      end
    end
  end

  Object.const_set(:EvaprojectRequirementsController, controller)
  # The pool has an entry in both sidebars, under two names; whichever one is showing is
  # the one lit.
  EvaprojectRequirementsController.current_menu_item do |current|
    current.instance_variable_get(:@project) ? :evaproject_requirements : :evaproject_requirements_global
  end
end

# The home page (Brian 2026-09-23, #185): counts over the pool, for one project or all of
# them. It reads the pool's own API, which already carries the visibility rules, so it
# needs no proxy of its own — and lives here rather than in an initializer of its own,
# which would have been one more file to mount on every host.
Rails.application.config.to_prepare do
  unless OpenProject::AccessControl.permission(:view_evaproject_dashboard)
    OpenProject::AccessControl.map do |map|
      map.permission :view_evaproject_dashboard,
                     { evaproject_dashboard: %i[index] },
                     permissible_on: :project,
                     public: true
    end
  end

  next if Object.const_defined?(:EvaprojectDashboardController)

  controller = Class.new(::ApplicationController) do
    before_action :require_login
    no_authorization_required! :index

    def index
      body = <<~HTML
        <div class="eva-agent-entry"><a href="/agent-access">Agent 接入</a></div>
        <div id="mp-dashboard" class="mp-dashboard" data-api="/requirements/api"></div>
      HTML
      render html: body.html_safe, layout: "global"
    end
  end

  Object.const_set(:EvaprojectDashboardController, controller)
  # The sidebar's 首页 is the core entry, and this page is what it now opens.
  EvaprojectDashboardController.menu_item :home
end

# The top bar's search results (Brian 2026-09-24, #218): requirements and handoffs of every
# project the reader may see. Like the home page it reads the pool's own API, which carries
# the visibility rules, so it needs no proxy of its own. Its path sits beside the pool's:
# OpenProject's own /search stays the native page for everything else.
Rails.application.config.to_prepare do
  unless OpenProject::AccessControl.permission(:view_evaproject_search)
    OpenProject::AccessControl.map do |map|
      map.permission :view_evaproject_search,
                     { evaproject_search: %i[index] },
                     permissible_on: :project,
                     public: true
    end
  end

  next if Object.const_defined?(:EvaprojectSearchController)

  controller = Class.new(::ApplicationController) do
    before_action :require_login
    no_authorization_required! :index

    def index
      body = <<~HTML
        <div id="mp-search" class="mp-search-page"></div>
      HTML
      render html: body.html_safe, layout: "global"
    end
  end

  Object.const_set(:EvaprojectSearchController, controller)
end

Rails.application.config.after_initialize do
  Rails.application.routes.append do
    get "/requirements/search", to: "evaproject_search#index", as: :evaproject_search
    get "/requirements", to: "evaproject_requirements#index", as: :evaproject_requirements
    match "/requirements/api/*rest", to: "evaproject_requirements#api", via: %i[get post]
    get "/projects/:project_id/requirements", to: "evaproject_requirements#index", as: :evaproject_project_requirements
    match "/projects/:project_id/requirements/api/*rest", to: "evaproject_requirements#api", via: %i[get post]
  end
  Rails.application.reload_routes!
end
