# frozen_string_literal: true

# Lets the top bar change the colour scheme — for a signed-in person and for a visitor.
#
# OpenProject already carries the preference and everything that acts on it:
# UserPreference::THEMES is exactly light, dark and sync_with_os, and the layout turns
# the chosen one into the data attributes Primer reads — including the OS-following case,
# which is handled in the frontend rather than here. So for a signed-in person this
# endpoint stores the value and nothing else. Writing our own switch on top of a second
# mechanism would have given the instance two ideas of what theme it is in.
#
# A visitor has no preference to store a choice in, and the login page is the one page
# every visitor sees (Brian 2026-09-23: it followed neither the system nor a switch).
# What a visitor gets by default is OpenProject's own Setting.user_default_theme, which
# the deployment pins to follow the OS (docker-compose.override.yml). A choice made on
# the login page goes into a cookie, and the one method every theme decision reads —
# UserPreference#theme — answers with it for the anonymous user. The layout's data
# attributes, the light/dark predicates and the logo variant therefore all see the same
# value, and the page is rendered in it by the server rather than flipped after load.
#
# The two sides are kept as one theme per browser (Brian 2026-09-23: the login page and
# the pages behind it disagreed — the account said light, the login page followed a dark
# system). Signed in, the browser remembers the account's theme, so the login page after
# a sign-out looks like the pages before it. A choice made on the login page is carried
# into the account at sign-in, as the most recent thing the person asked for.
#
# The setting is also in 我的帐号 > 设置. Having it in the top bar is not a duplicate
# mechanism, only a second door to the same preference.

EVAPROJECT_VISITOR_THEME_COOKIE = "evaproject_theme"
# Set with a choice made while signed out; the next signed-in request carries that choice
# into the account and clears it.
EVAPROJECT_VISITOR_THEME_PENDING_COOKIE = "evaproject_theme_pending"

Rails.application.config.to_prepare do
  unless Object.const_defined?(:EvaprojectVisitorTheme)
    Object.const_set(:EvaprojectVisitorTheme, Module.new do
      # Only the anonymous user's preference is overridden: a signed-in person's own
      # choice always wins over whatever a cookie from before they signed in says.
      def theme
        chosen = RequestStore.store[:evaproject_visitor_theme]
        chosen && user&.anonymous? ? chosen : super
      end
    end)
  end
  UserPreference.prepend(EvaprojectVisitorTheme) unless UserPreference < EvaprojectVisitorTheme

  unless ApplicationController.private_method_defined?(:evaproject_sync_theme)
    ApplicationController.class_eval do
      before_action :evaproject_sync_theme

      private

      # Validated here, so an unknown value in the cookie is the same as no cookie.
      def evaproject_sync_theme
        chosen = cookies[EVAPROJECT_VISITOR_THEME_COOKIE].to_s
        chosen = nil unless UserPreference::THEMES.map(&:to_s).include?(chosen)
        unless User.current.logged?
          RequestStore.store[:evaproject_visitor_theme] = chosen if chosen
          return
        end

        preference = User.current.pref
        if chosen && cookies[EVAPROJECT_VISITOR_THEME_PENDING_COOKIE].present?
          preference.theme = chosen
          preference.save
          cookies.delete(EVAPROJECT_VISITOR_THEME_PENDING_COOKIE)
        elsif preference.theme != chosen
          cookies.permanent[EVAPROJECT_VISITOR_THEME_COOKIE] = { value: preference.theme, httponly: true, same_site: :lax }
        end
      rescue StandardError => e
        # A theme is never worth failing a page over.
        Rails.logger.error("Eva-Project theme sync failed: #{e.class}: #{e.message}")
      end
    end
  end

  next if Object.const_defined?(:EvaprojectThemeController)

  controller = Class.new(::ApplicationController) do
    # A visitor on the login page chooses too, and on an instance that requires login
    # this filter would send that request to the login page it came from.
    skip_before_action :check_if_login_required

    # Changing one's own display preference is not a project permission, and there is
    # nothing for `do_authorize` to map it onto.
    no_authorization_required! :update

    def update
      theme = params[:theme].to_s
      unless UserPreference::THEMES.map(&:to_s).include?(theme)
        return render json: { error: "未知主题：#{theme}" }, status: :unprocessable_entity
      end

      if User.current.logged?
        preference = User.current.pref
        preference.theme = theme
        preference.save!
        return render json: { theme: preference.reload.theme }
      end

      # Read by the server on every request, never by a script, so it is httponly.
      cookies.permanent[EVAPROJECT_VISITOR_THEME_COOKIE] = { value: theme, httponly: true, same_site: :lax }
      # A session cookie: a choice nobody signs in after does not linger into a later
      # sign-in and overwrite the account.
      cookies[EVAPROJECT_VISITOR_THEME_PENDING_COOKIE] = { value: "1", httponly: true, same_site: :lax }
      render json: { theme: theme }
    rescue StandardError => e
      Rails.logger.error("Eva-Project theme update failed: #{e.class}: #{e.message}")
      render json: { error: "主题没能保存，请重试" }, status: :internal_server_error
    end
  end

  Object.const_set(:EvaprojectThemeController, controller)
end

Rails.application.config.after_initialize do
  Rails.application.routes.append do
    post "/evaproject-theme", to: "evaproject_theme#update", as: :evaproject_theme
  end
  Rails.application.reload_routes!
end
