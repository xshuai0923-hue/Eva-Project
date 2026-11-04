# frozen_string_literal: true
require "net/http"

Rails.application.config.to_prepare do
  next if Object.const_defined?(:EvaprojectAgentAccessController)
  controller = Class.new(::ApplicationController) do
    before_action :require_login
    no_authorization_required! :index, :api

    def index
      code = ERB::Util.html_escape(params[:code].to_s)
      mcp_url = ERB::Util.html_escape(ENV.fetch("EVAPROJECT_MCP_PUBLIC_URL", ""))
      render html: %(<section id="eva-agent-access" class="eva-agent-access" data-mcp-url="#{mcp_url}" data-code="#{code}"></section>).html_safe, layout: "global"
    end

    def api
      operation = params[:operation].to_s
      allowed = request.get? ? %w[request] : %w[approve deny]
      return head(:not_found) unless allowed.include?(operation)
      base = ENV.fetch("EVAPROJECT_MCP_INTERNAL_URL", "http://mcp:8081")
      target = URI.join(base, "/agent-connect/#{operation}")
      target.query = URI.encode_www_form(code: params[:code].to_s) if request.get?
      outbound = request.get? ? Net::HTTP::Get.new(target) : Net::HTTP::Post.new(target)
      outbound["Cookie"] = request.headers["Cookie"].to_s
      outbound["Content-Type"] = "application/json"
      outbound["Origin"] = "#{target.scheme}://#{target.host}:#{target.port}"
      outbound.body = JSON.generate(code: params[:code].to_s) unless request.get?
      result = Net::HTTP.start(target.host, target.port, open_timeout: 5, read_timeout: 20) { |http| http.request(outbound) }
      response.headers["Cache-Control"] = "no-store"
      render json: result.body, status: result.code.to_i
    rescue StandardError
      render json: { error: "暂时无法连接 Eva，请稍后重试。" }, status: :bad_gateway
    end
    private

    def login_back_url_params
      params.permit(:code)
    end
  end
  Object.const_set(:EvaprojectAgentAccessController, controller)
end
Rails.application.routes.append do
  get "/agent-access", to: "evaproject_agent_access#index"
  get "/agent-access/api/request", to: "evaproject_agent_access#api", defaults: { operation: "request" }
  post "/agent-access/api/:operation", to: "evaproject_agent_access#api"
end
