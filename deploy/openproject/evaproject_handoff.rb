# frozen_string_literal: true

# Serves the handoff module from inside OpenProject.
#
# The module used to be a standalone page on the MCP port with its own header, which
# made it a second system rather than a part of this one. Here it is an ordinary
# OpenProject page: OpenProject renders the top bar, the menus and the theme, so light
# and dark follow the instance instead of being guessed at.
#
# The JSON API still lives in the MCP. This controller proxies to it over the internal
# network and forwards the browser's session cookie, so the MCP authenticates exactly as
# it did before — no second identity path, no CORS, and the page is same-origin.

require "net/http"

EVAPROJECT_MCP_INTERNAL_URL = ENV.fetch("EVAPROJECT_MCP_INTERNAL_URL", "http://mcp:8081")

# Without a declared permission, OpenProject cannot map this controller's URLs to one.
# The menu helper rescues that and quietly hides the entry, but `do_authorize` does not
# rescue it, so any code path reaching it turns the whole page into a 500.
#
# Access here is intentionally open to any logged-in user: what a person may actually
# see is decided per record by the MCP from their identity, exactly as it is for an
# Agent. Declaring it keeps OpenProject's lookup resolvable rather than raising.
# Registered from to_prepare because OpenProject's autoloader is not yet serving
# `OpenProject::AccessControl::Mapper` while initializers run.
Rails.application.config.to_prepare do
  unless OpenProject::AccessControl.permission(:view_handoffs)
    OpenProject::AccessControl.map do |map|
      map.permission :view_handoffs,
                     { evaproject_handoff: %i[index api] },
                     permissible_on: :project,
                     public: true
    end
  end

  next if Object.const_defined?(:EvaprojectHandoffController)

  controller = Class.new(::ApplicationController) do
    before_action :find_optional_project
    before_action :require_login

    # OpenProject requires every action to declare an authorization check. Handoff
    # visibility is not a project permission: it is decided by the MCP from the caller's
    # identity, exactly as it is for an Agent, so this controller states that it carries
    # no project-level check of its own and leaves the decision there.
    no_authorization_required! :index, :api

    def index
      scope = @project ? "/projects/#{CGI.escape(@project.identifier)}/handoff" : "/handoff"
      # Only the container: the stylesheet and module are injected into the layout head,
      # because Turbo drops <script> elements that arrive in a navigation's body.
      body = <<~HTML
        <div id="mp-handoff" class="mp-handoff"
             data-api="#{ERB::Util.html_escape(scope)}/api"
             data-project="#{ERB::Util.html_escape(@project&.identifier)}"></div>
      HTML
      render html: body.html_safe, layout: @project ? "base" : "global"
    end

    # Everything under .../handoff/api/* is handed to the MCP unchanged.
    def api
      target = URI.join(EVAPROJECT_MCP_INTERNAL_URL, "/handoff/api/#{params[:rest]}")
      query = request.query_parameters.except("rest", "project_id")
      query["project"] ||= @project.identifier if @project
      target.query = query.to_query if query.any?

      proxied = proxy_request(target)
      render json: proxied.body, status: proxied.code.to_i
    rescue StandardError => e
      Rails.logger.error("Eva-Project handoff proxy failed: #{e.class}: #{e.message}")
      render json: { error: "无法连接交接服务，请稍后重试" }, status: :bad_gateway
    end

    private

    def proxy_request(target)
      klass = case request.request_method
              when "POST" then Net::HTTP::Post
              else Net::HTTP::Get
              end
      outbound = klass.new(target)
      outbound["Cookie"] = request.headers["Cookie"].to_s
      outbound["Content-Type"] = "application/json"
      # The MCP checks the request origin on writes; it sees this proxy, not the browser.
      outbound["Origin"] = "#{target.scheme}://#{target.host}:#{target.port}"
      outbound.body = request.raw_post if request.post?

      Net::HTTP.start(target.host, target.port, read_timeout: 20, open_timeout: 5) do |http|
        http.request(outbound)
      end
    end
  end

  # Naming the class first: `menu_item` derives its key from `controller_path`, which is
  # nil while the class is still anonymous.
  Object.const_set(:EvaprojectHandoffController, controller)
  # Two entries, one per sidebar, under two names; whichever one is showing is lit.
  EvaprojectHandoffController.current_menu_item do |current|
    current.instance_variable_get(:@project) ? :evaproject_handoff : :evaproject_handoff_global
  end
end

# Handoffs are work packages in the same project, so the native work package list shows
# them next to requirements unless told otherwise. OpenProject's default filter is
# hardcoded to "open" with no per-project override, so the exclusion is added where that
# default is built.
#
# Only a query that had no filters at all is touched: an explicitly chosen view, or one
# the person filtered themselves, is left exactly as asked for. The added filter is a
# normal filter chip, so it can be removed to see handoffs in the native list.
Rails.application.config.to_prepare do
  next if Object.const_defined?(:EvaProjectRequirementDefaultFilter)

  mod = Module.new do
    def add_default_filter
      had_filters = filters.present?
      super
      return if had_filters

      handoff_type = Type.find_by(name: "交接")
      return if handoff_type.nil?

      add_filter("type_id", "!", [handoff_type.id.to_s])
    rescue StandardError => e
      # A default query must never fail to build because of this.
      Rails.logger.warn("Eva-Project default filter skipped: #{e.class}: #{e.message}")
    end
  end

  Object.const_set(:EvaProjectRequirementDefaultFilter, mod)
  Query.prepend(mod)
end

Rails.application.config.after_initialize do
  Rails.application.routes.append do
    get "/handoff", to: "evaproject_handoff#index", as: :evaproject_handoff
    match "/handoff/api/*rest", to: "evaproject_handoff#api", via: %i[get post]
    get "/projects/:project_id/handoff", to: "evaproject_handoff#index", as: :evaproject_project_handoff
    match "/projects/:project_id/handoff/api/*rest", to: "evaproject_handoff#api", via: %i[get post]
  end
  Rails.application.reload_routes!
end
