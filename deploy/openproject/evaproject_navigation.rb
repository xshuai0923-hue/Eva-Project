# Brian 2026-09-23（#183、#185）：首页是统计 Dashboard，和需求池分开。此前「/」重定向到
# 需求池，房子图标和侧栏「首页」因此都进了需求池，#181 之后更是直接被带进上次选过的项目
# （#184）。prepend 才能排在核心的 root 之前；匿名访问会照常被弹去登录，登录后回到这里。
Rails.application.routes.prepend do
  get "/", to: "evaproject_dashboard#index", as: :evaproject_home
end

Redmine::MenuManager.map :account_menu do |menu|
  # Brian 2026-09-22：这一条以前指向 MCP 端口上那张自己写的页面，是最后一个还在
  # 框架外面的入口。现在是站内路由，所以外链图标也去掉了。
  menu.push :evaproject_user_management,
            "/mcp-tokens",
            caption: "MCP 用户管理",
            icon: :key,
            after: :administration,
            if: ->(_) { User.current.admin? }

  # Brian 2026-09-24（#237）：备份要在系统里看、设、恢复，不是登服务器装定时任务。
  menu.push :evaproject_backup,
            "/backups",
            caption: "备份",
            icon: :database,
            after: :evaproject_user_management,
            if: ->(_) { User.current.admin? }
end

# The handoff module lives beside the requirement pool but has its own page, so the
# native work package list stays a requirement list.
# The main entry sits in the global modules menu: handoffs span projects, and the page
# lets you switch project once inside.
# The requirement pool is the day-to-day entry, so it sits ahead of the native work
# package list rather than beside it. The native list stays reachable: it is where change
# history, comments, attachments, search and export live.
# Opened globally it lands on the project list; a project is chosen there and filtering
# happens inside it.
#
# Both sidebars keep the daily entries — 首页、需求池、上下文交接、工作包 — in the
# same relative order. Native project navigation stays available too: the global
# project list, and each project's members and settings with OpenProject permissions.
# 首页 is the core entry in the global sidebar and an entry of ours in a project's.

# Register sidebar entries after the core menus so relative positions have targets.
Rails.application.config.after_initialize do
  Redmine::MenuManager.map :project_menu do |menu|
    # The home page is not narrowed to a project, so the project the menu merges into
    # every project entry's url is taken back out; otherwise it trails along as a query.
    menu.push :evaproject_home,
              ->(_project) { { controller: "/evaproject_dashboard", action: "index", project_id: nil } },
              caption: "首页",
              icon: "home",
              first: true,
              if: ->(project) { User.current.logged? && project.present? }

    menu.push :evaproject_requirements,
              ->(project) {
                project ? { controller: "/evaproject_requirements", action: "index", project_id: project.identifier }
                        : { controller: "/evaproject_requirements", action: "index" }
              },
              caption: "需求池",
              icon: "list-unordered",
              before: :work_packages,
              if: ->(project) { User.current.logged? && project.present? }
  end

  Redmine::MenuManager.map :global_menu do |menu|
    menu.push :evaproject_requirements_global,
              { controller: "/evaproject_requirements", action: "index" },
              caption: "需求池",
              icon: "list-unordered",
              after: :home,
              skip_permissions_check: true,
              if: ->(_) { User.current.logged? }

    menu.push :evaproject_handoff_global,
              { controller: "/evaproject_handoff", action: "index" },
              caption: "上下文交接",
              icon: "arrow-switch",
              # Brian 2026-09-22：工作包放最后。它是兜底入口，不是每天用的。
              before: :work_packages,
              skip_permissions_check: true,
              if: ->(_) { User.current.logged? }
  end

  # The project entry is the same module narrowed to one project.
  Redmine::MenuManager.map :project_menu do |menu|
    # A Hash url, not a string. OpenProject resolves a menu item's permission through
    # `AccessControl.allow_actions(controller:, action:)`; a string is looked up as a
    # permission *name* instead, is never found, and raises where nothing rescues it —
    # turning the project page into a 500 rather than just hiding the entry.
    menu.push :evaproject_handoff,
              ->(project) {
                project ? { controller: "/evaproject_handoff", action: "index", project_id: project.identifier }
                        : { controller: "/evaproject_handoff", action: "index" }
              },
              caption: "上下文交接",
              icon: "arrow-switch",
              before: :work_packages,
              if: ->(project) { User.current.logged? && project.present? }
  end
end

# Brian 2026-09-23（#189）：顶栏右侧不要「+」（快速新建）。它没有开关，只按权限决定显示，
# 所以在核心判断「显示与否」的那一处答否，核心随之照它自己「不显示」的写法渲染成空。
# 同一句话里还不要的通知入口，用的是 OpenProject 自己的设置，见 docker-compose.override.yml。
Rails.application.config.to_prepare do
  next if Object.const_defined?(:EvaProjectNoQuickAdd)

  Object.const_set(:EvaProjectNoQuickAdd, Module.new do
    private

    def show_quick_add_menu? = false
  end)
  Redmine::MenuManager::TopMenu::QuickAddMenu.prepend(EvaProjectNoQuickAdd)
end

# Brian 2026-09-23（#195）：在首页、全局需求池、全局上下文交接用顶栏的项目下拉选项目，
# 会进到 OpenProject 原生的项目概览——项目侧栏 2026-09-22 起就不给这一页了。下拉去的是
# /projects/<标识>?jump=<当前页的菜单项>，项目页只在项目菜单里有同名项时才转过去，而这几页
# 是全局菜单项。现在全局项先换成项目里对应的那一项；仍没有去处的，包括不带 jump 的，一律进
# 该项目的需求池：项目的落地页是需求池，不是概览。
Rails.application.config.to_prepare do
  next if Object.const_defined?(:EvaProjectProjectLanding)

  counterparts = {
    "evaproject_requirements_global" => :evaproject_requirements,
    "evaproject_handoff_global" => :evaproject_handoff
  }.freeze

  Object.const_set(:EvaProjectProjectLanding, Module.new do
    define_method(:jump_to_project_menu_item) do
      wanted = counterparts.fetch(params[:jump].to_s, params[:jump].presence)
      return if wanted && redirect_to_project_menu_item(@project, wanted)

      redirect_to_project_menu_item(@project, :evaproject_requirements)
    end
  end)
  Overviews::OverviewsController.prepend(EvaProjectProjectLanding)
end

# Brian 2026-09-23（#203）：站点图标换成陶土色的 M，字形就是顶栏那个 M（Kaushan Script）。
# OpenProject 只在「没有自定义图标」时输出自己的两条图标链接，这里答它有，它就不输出——
# 不然页面上两套图标并存，浏览器用哪一套没有定准。我们的图标由下面的 head 钩子给。
Rails.application.config.to_prepare do
  next if Object.const_defined?(:EvaProjectFavicon)

  Object.const_set(:EvaProjectFavicon, Module.new do
    def apply_custom_favicon? = true
    def apply_custom_touch_icon? = true
  end)
  CustomStylesHelper.prepend(EvaProjectFavicon)
end

Rails.application.config.after_initialize do
  Redmine::MenuManager.map :account_menu do |menu|
    menu.push :evaproject_agent_access,
              "/agent-access",
              caption: "Agent 接入",
              icon: :link,
              after: :my_account,
              if: ->(_) { User.current.logged? }
  end

  # 全局侧栏保留日常工作入口及原生项目列表，其他非核心模块继续隐藏。
  # 工作包是有意留的兜底编辑入口——变更历史、全文搜索、导出、甘特只有原生页面有。
  # 删这一步放在 after_initialize 里：这几条由核心在更早的阶段注册，在文件顶层删会
  # 删到还不存在的东西。exists? 先问一句，免得哪天核心改名把 web 一起带崩。
  # ⚠️ The list is long because a global entry appears as soon as ANY visible project
  # enables its module. Trimming the modules is the root fix (see the bootstrap), but a
  # project can switch one back on at any time and the sidebar would sprout 面板/会议/
  # 新闻/工时和成本 again — which is exactly what happened the moment another session
  # created a project. Deleting them here keeps the sidebar to those entries whatever
  # anyone enables.
  Redmine::MenuManager.map :global_menu do |menu|
    %i[my_page portfolios gantt wikis
       my_time_tracking activity calendar_view team_planners
       boards meetings news cost_reports_global].each do |name|
      menu.delete(name) if menu.exists?(name)
    end
  end

  # 成员和项目设置保留原生入口及其权限检查。管理后台的「项目列表」是显示设置，
  # 不能替代真实项目列表或成员管理。仅隐藏概览：项目默认仍落在需求池。
  Redmine::MenuManager.map :project_menu do |menu|
    menu.delete(:overview) if menu.exists?(:overview)
  end

  # 管理里 OpenProject 自带的「备份」只能凭备份令牌单次打包下载，不能定时、不能恢复。
  # 头像菜单里已经有同名的「备份」页（#237），两处同名会把人带到做不了事的那一处。
  Redmine::MenuManager.map :admin_menu do |menu|
    menu.delete(:backups) if menu.exists?(:backups)
  end

  require "open_project/hook"

  next if Object.const_defined?(:EvaProjectBrandingHook)

  hook = Class.new(OpenProject::Hook::ViewListener) do
    def view_layouts_base_html_head(_context = {})
      # The chrome — the top bar, its branding and the appearance control — is served to
      # every visitor, signed in or not: the login page wears the same bar, and a visitor
      # chooses a theme there too (kept in a cookie; see evaproject_theme.rb).
      branding = <<~HTML
        <link rel="icon" type="image/svg+xml" href="/evaproject/favicon.svg?v=836bc2fb81">
        <link rel="icon" type="image/png" sizes="64x64" href="/evaproject/favicon-64.png?v=a0c4ecf736">
        <link rel="apple-touch-icon" sizes="180x180" href="/evaproject/apple-touch-icon.png?v=e59501140c">
        <link rel="stylesheet" href="/evaproject/theme.css?v=32e7fbe08c">
        <link rel="stylesheet" href="/evaproject/chrome.css?v=e753d37d07">
        <script type="module" src="/evaproject/chrome.js?v=344f227ca2" data-evaproject-chrome></script>
      HTML

      if User.current.logged?
        branding += <<~HTML
          <link rel="stylesheet" href="/evaproject/agent-access.css?v=c2443cd487">
          <script type="module" src="/evaproject/agent-access.js?v=2a3245939f"></script>
          <link rel="stylesheet" href="/evaproject/prose.css?v=127223fef1">
          <link rel="stylesheet" href="/evaproject/handoff.css?v=ac40e81da5">
          <script type="module" src="/evaproject/handoff.js?v=8468477eb1" data-evaproject-handoff></script>
          <link rel="stylesheet" href="/evaproject/requirements.css?v=97cdee4fb8">
          <script type="module" src="/evaproject/requirements.js?v=93036b3a48" data-evaproject-requirements></script>
          <link rel="stylesheet" href="/evaproject/dashboard.css?v=784f83cfdb">
          <script type="module" src="/evaproject/dashboard.js?v=25d3748ccb" data-evaproject-dashboard></script>
          <link rel="stylesheet" href="/evaproject/search.css?v=a314a3a893">
          <script type="module" src="/evaproject/search.js?v=bf80cf4def" data-evaproject-search></script>
        HTML
      end

      # Only an administrator can reach the page these belong to, so only an
      # administrator pays for them.
      if User.current.admin?
        branding += <<~HTML
          <link rel="stylesheet" href="/evaproject/tokens.css?v=c153412794">
          <script type="module" src="/evaproject/tokens.js?v=61a60cecd6" data-evaproject-tokens></script>
          <link rel="stylesheet" href="/evaproject/backup.css?v=f092f9a839">
          <script type="module" src="/evaproject/backup.js?v=550b0df3e8" data-evaproject-backup></script>
        HTML
      end

      branding.html_safe
    end
  end

  Object.const_set(:EvaProjectBrandingHook, hook)
end
