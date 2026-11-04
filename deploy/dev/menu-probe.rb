# Renders the real menus. Registration alone proves nothing: an item still has to pass
# the permission check and render its icon, and either failure is silent or fatal.
User.current = User.find_by!(login: "admin")
project = Project.find_by!(identifier: ENV.fetch("EVAPROJECT_PROBE_PROJECT", "eva-project"))

controller = WorkPackagesController.new
controller.request = ActionDispatch::TestRequest.create
controller.response = ActionDispatch::TestResponse.new
controller.params = ActionController::Parameters.new(
  controller: "work_packages", action: "index", project_id: project.identifier
)
def controller.action_name = "index"
view = controller.view_context
view.instance_variable_set(:@project, project)

out = {}
%i[project_menu global_menu].each do |menu|
  html = view.render_menu(menu, menu == :project_menu ? project : nil).to_s
  prefix = menu == :project_menu ? "/projects/#{project.identifier}" : ""
  expected = ["/", "#{prefix}/requirements", "#{prefix}/handoff", "#{prefix}/work_packages"]
  order = Nokogiri::HTML.fragment(html).css("a[href]").map { |link| URI.parse(link["href"]).path }
                  .select { |path| expected.include?(path) }.uniq
  raise "#{menu} sidebar order: #{order.inspect}, expected #{expected.inspect}" unless order == expected
  out[menu] = {
    primary_order: order,
    rendered: html.length,
    handoff_visible: html.include?("上下文交接"),
    handoff_href: html[/href="([^"]*handoff[^"]*)"/, 1]
  }
end
out[:default_query_filters] = Query.new_default(project: project, user: User.current)
                                   .filters.map { |f| "#{f.name} #{f.operator}" }
puts JSON.generate(out)
