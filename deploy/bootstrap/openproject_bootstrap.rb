# frozen_string_literal: true

require "json"

# IDs can be supplied for installations with custom status names. Never infer a
# status from its position: OpenProject seed workflows differ by language/version.
def eva_status_maps(output_dir)
  override_path = File.join(output_dir, "status-overrides.json")
  overrides = File.exist?(override_path) ? JSON.parse(File.read(override_path)) : {}
  definitions = {
    "open" => [false, ["new", "新增"]],
    "active" => [false, ["in progress", "in process", "正在处理", "进行中"]],
    "resolved" => [false, ["resolved", "developed", "已解决", "已开发"]],
    "closed" => [true, ["closed", "已关闭"]],
    "hold" => [false, ["on hold", "暂停", "暂缓"]],
    "rejected" => [true, ["rejected", "已拒绝"]]
  }
  unknown = overrides.keys - definitions.keys
  raise "Unknown status override keys: #{unknown.join(', ')}" unless unknown.empty?

  statuses = Status.all.to_a
  selected = definitions.to_h do |key, (closed, names)|
    candidates = if overrides.key?(key)
                   statuses.select { |status| status.id == Integer(overrides.fetch(key)) }
                 else
                   statuses.select { |status| names.include?(status.name.strip.downcase) }
                 end
    unless candidates.one? && candidates.first.is_closed == closed
      raise "Cannot uniquely resolve #{key} status (closed=#{closed}). Set its ID in #{override_path}"
    end
    [key, "/api/v3/statuses/#{candidates.first.id}"]
  end

  pool_types = %w[task bug feature].map { |key| EvaProjectPoolTypes.core_type(key) }.compact
  active_id = selected.fetch("active").split("/").last.to_i
  resolved_id = selected.fetch("resolved").split("/").last.to_i
  # Eva keeps its review stage in a custom field. Some native workflows (Task in
  # particular) have no resolved stage, so their native status stays active.
  supports_review = pool_types.all? do |type|
    Workflow.where(type_id: type.id, old_status_id: active_id, new_status_id: resolved_id).exists?
  end
  unless supports_review
    raise "Explicit resolved status is not reachable from active for every pool type" if overrides.key?("resolved")
    selected["resolved"] = selected.fetch("active")
    warn "Native workflows have no shared review transition; Eva review stage uses the active native status"
  end
  open_id = selected.fetch("open").split("/").last.to_i
  pool_types.each do |type|
    unless Workflow.where(type_id: type.id, old_status_id: open_id, new_status_id: active_id).exists?
      raise "No open-to-active workflow transition for #{type.name}; configure its workflow before syncing"
    end
  end

  {
    "statusHrefs" => {
      "待确认" => selected.fetch("open"), "待认领" => selected.fetch("open"),
      "进行中" => selected.fetch("active"), "已实现待提交" => selected.fetch("active"),
      "待验证/验收" => selected.fetch("resolved"), "已完成" => selected.fetch("closed"),
      "暂缓" => selected.fetch("hold"), "取消" => selected.fetch("rejected"),
      "已合并" => selected.fetch("closed")
    },
    "handoffStatusHrefs" => {
      "草稿" => selected.fetch("open"), "待接手" => selected.fetch("open"),
      "已接手" => selected.fetch("active"), "已归档" => selected.fetch("closed"),
      "已作废" => selected.fetch("rejected")
    }
  }
end

output_dir = ENV.fetch("EVAPROJECT_BOOTSTRAP_OUTPUT_DIR", "/evaproject-runtime")
# Resolve before bootstrap writes anything, so an unknown name fails explicitly.
status_maps = eva_status_maps(output_dir)
status_map_mode = ENV["EVAPROJECT_STATUS_MAP_ONLY"]
if status_map_mode
  raise "EVAPROJECT_STATUS_MAP_ONLY must be check or update" unless %w[check update].include?(status_map_mode)
  map_path = File.join(output_dir, "field-map.json")
  map = JSON.parse(File.read(map_path))
  changes = status_maps.to_h { |key, value| [key, { before: map.fetch(key), after: value }] }
  if status_map_mode == "update"
    File.write("#{map_path}.tmp", JSON.pretty_generate(map.merge(status_maps)))
    File.chmod(0o644, "#{map_path}.tmp")
    File.rename("#{map_path}.tmp", map_path)
  end
  puts JSON.generate(mode: status_map_mode, changes: changes)
  exit
end
FileUtils.mkdir_p(output_dir)

admin = User.find_by!(login: "admin")
User.current = admin

# Clearing demo content and setting the welcome text belong to a fresh install. On a
# rerun — which is what an upgrade is — they would destroy projects and queries that
# happen to share a seeded name, and overwrite text someone has since edited. Every
# other step in this script is additive and safe to repeat.
first_run = Project.find_by(identifier: "eva-project").nil?

if first_run
  Project.where(identifier: %w[demo-project your-scrum-project]).find_each(&:destroy!)
  Query.where(
    project_id: nil,
    name: ["Epic children: User stories and bugs", "User story children: Tasks", "!!!__O__o__O__!!!"]
  ).destroy_all
  Setting.demo_projects_available = false
  Setting.boards_demo_data_available = false
  Setting.welcome_text = <<~MARKDOWN
    # 欢迎使用 Eva Project

    Eva Project 是团队的多用户需求池，用于管理项目需求、公开与私有可见性、需求提交人、负责 Agent、认领和完成状态。
  MARKDOWN
end

project_specs = {
  "eva-project" => "Eva-Project Requirements"
}.freeze

projects = project_specs.map do |identifier, name|
  project = Project.find_by(identifier: identifier)
  unless project
    project = Project.new(
      name: name,
      identifier: identifier,
      public: false,
      active: true,
      workspace_type: "project"
    )
    project.enabled_module_names = %w[work_package_tracking wiki]
    project.save!
  end
  project
end

type = EvaProjectPoolTypes.core_type("task")
raise "No work package type is available" unless type

requirement_types = [type, EvaProjectPoolTypes.core_type("bug"), EvaProjectPoolTypes.core_type("feature")].uniq

# Handoffs are work packages of their own type inside the same project as the
# requirements they reference, so relations and permissions stay in-project.
handoff_type = Type.find_by(name: "交接")
unless handoff_type
  handoff_type = Type.new(name: "交接", is_default: false, is_milestone: false)
  handoff_type.position = (Type.maximum(:position) || 0) + 1
  handoff_type.attribute_groups = Type.new.default_attribute_groups if handoff_type.attribute_groups.blank?
  handoff_type.save!
end

projects.each do |project|
  (requirement_types + [handoff_type]).each do |item|
    project.types << item unless project.types.exists?(item.id)
  end
end

legacy_owner_field = WorkPackageCustomField.find_by(name: "所属用户 ID")
legacy_owner_field.update!(name: "需求提交人") if legacy_owner_field && !WorkPackageCustomField.exists?(name: "需求提交人")

field_specs = {
  requirementId: { name: "需求 ID", format: "string" },
  requesterType: {
    name: "提出者类型", format: "list",
    options: %w[人 Agent 系统 未知]
  },
  requesterName: { name: "提出者名称", format: "string" },
  requesterId: { name: "提出者 ID", format: "string" },
  visibility: {
    name: "可见性", format: "list",
    options: %w[公开 私有]
  },
  ownerUserId: { name: "需求提交人", format: "string" },
  recordedAt: { name: "原记录时间", format: "string" },
  sourceUpdatedAt: { name: "原更新时间", format: "string" },
  modules: {
    name: "模块", format: "list", multi: true,
    options: %w[iOS Desktop Runtime 网关 开发流程]
  },
  responsibleAgent: {
    name: "负责 Agent", format: "list",
    options: %w[Codex Claude Mila 不限 待确认]
  },
  claimedAgent: {
    name: "实际认领 Agent", format: "list",
    options: %w[Codex Claude Mila]
  },
  claimedSession: { name: "认领 Session", format: "string" },
  claimLabel: { name: "认领标签", format: "string" },
  claimedAt: { name: "认领时间", format: "string" },
  claimScope: { name: "认领范围", format: "text" },
  intakeStatus: {
    name: "受理状态", format: "list",
    options: %w[待确认 已受理 不受理]
  },
  state: {
    name: "需求状态", format: "list",
    options: ["待确认", "待认领", "进行中", "已实现待提交", "待验证/验收", "已完成", "暂缓", "取消", "已合并"]
  },
  priority: { name: "用户优先级", format: "string" },
  proposedAt: { name: "提出时间", format: "string" },
  proposedTimePrecision: {
    name: "时间精度", format: "list",
    options: %w[timestamp date unknown]
  },
  sourceSessionId: { name: "来源 Session", format: "string" },
  sourceMessageId: { name: "来源消息", format: "string" },
  sourceLabel: { name: "来源标签", format: "string" },
  requiredForParent: { name: "父需求必需项", format: "bool" },
  verificationStatus: {
    name: "验证状态", format: "list",
    options: %w[未验证 已验证 不适用]
  },
  userAcceptance: {
    name: "用户验收", format: "list",
    options: %w[待确认 待验收 已验收 不适用]
  }
}.freeze

# Fields both record kinds genuinely share: the stable identifier, who owns it and
# who may see it, and the claim. Everything else stays on requirement types only, so a
# handoff form does not sprout 需求状态 or 提出者类型.
shared_with_handoff = %i[
  requirementId ownerUserId visibility modules sourceSessionId
  claimedAgent claimedSession claimLabel claimedAt claimScope
].freeze

field_map = {}
field_specs.each do |logical_name, spec|
  field = WorkPackageCustomField.find_or_initialize_by(name: spec.fetch(:name))
  if field.new_record?
    field.field_format = spec.fetch(:format)
    field.multi_value = spec[:multi] == true
  elsif field.field_format != spec.fetch(:format)
    raise "Field #{field.name} exists with format #{field.field_format}, expected #{spec.fetch(:format)}"
  end

  field.is_required = false
  field.is_filter = true
  field.is_for_all = true
  field.searchable = %w[string text list].include?(field.field_format)
  field.save!

  projects.each { |project| field.projects << project unless field.projects.exists?(project.id) }
  bound_types = requirement_types + (shared_with_handoff.include?(logical_name) ? [handoff_type] : [])
  bound_types.each { |item| field.types << item unless field.types.exists?(item.id) }

  options = {}
  Array(spec[:options]).each_with_index do |value, index|
    custom_option = field.custom_options.find_or_initialize_by(value: value)
    custom_option.position = index + 1
    custom_option.save!
    options[value] = "/api/v3/custom_options/#{custom_option.id}"
  end

  field_map[logical_name] = {
    key: "customField#{field.id}",
    # "text" is a long text field, which API v3 carries as { raw } rather than a bare
    # string. Collapsing it into "text" alongside string fields is what made writes to
    # 认领范围 vanish silently.
    kind: case spec.fetch(:format)
          when "list" then "list"
          when "bool" then "bool"
          when "text" then "formattable"
          else "text"
          end,
    multi: spec[:multi] == true,
    options: options
  }.compact
end

# Bound to the handoff type only: is_for_all controls project availability, while
# field.types controls which work package forms show them. Requirement forms keep
# exactly the fields they have today.
handoff_field_specs = {
  handoffThread: { name: "交接线程", format: "string" },
  handoffState: {
    name: "交接状态", format: "list",
    options: %w[草稿 待接手 已接手 已归档 已作废]
  },
  handoffPrevious: { name: "上一任交接", format: "string" },
  handoffExpectedAgent: {
    name: "期望接手 Agent", format: "list",
    options: %w[Codex Claude Mila 不限]
  },
  handoffRepository: { name: "仓库", format: "string" },
  handoffBranch: { name: "分支", format: "string" },
  handoffBaseCommit: { name: "基线提交", format: "string" },
  handoffTodoTotal: { name: "待办总数", format: "int" },
  handoffTodoDone: { name: "已完成待办", format: "int" }
}.freeze

handoff_field_specs.each do |logical_name, spec|
  field = WorkPackageCustomField.find_or_initialize_by(name: spec.fetch(:name))
  if field.new_record?
    field.field_format = spec.fetch(:format)
    field.multi_value = false
  elsif field.field_format != spec.fetch(:format)
    raise "Field #{field.name} exists with format #{field.field_format}, expected #{spec.fetch(:format)}"
  end

  field.is_required = false
  field.is_filter = true
  field.is_for_all = true
  field.searchable = %w[string text list].include?(field.field_format)
  field.save!

  projects.each { |project| field.projects << project unless field.projects.exists?(project.id) }
  field.types << handoff_type unless field.types.exists?(handoff_type.id)

  options = {}
  Array(spec[:options]).each_with_index do |value, index|
    custom_option = field.custom_options.find_or_initialize_by(value: value)
    custom_option.position = index + 1
    custom_option.save!
    options[value] = "/api/v3/custom_options/#{custom_option.id}"
  end

  field_map[logical_name] = {
    key: "customField#{field.id}",
    kind: case spec.fetch(:format)
          when "list" then "list"
          when "bool" then "bool"
          when "int" then "int"
          when "text" then "formattable"
          else "text"
          end,
    multi: false,
    options: options
  }.compact
end

default_requirement_columns = %i[ownerUserId visibility responsibleAgent claimedAgent state].map do |logical_name|
  field_map.fetch(logical_name).fetch(:key).sub("customField", "cf_")
end
Setting.work_package_list_default_columns = ["id", "subject", "type", *default_requirement_columns]

# A new project has to be usable as a requirement pool the moment it exists. Left at
# OpenProject's factory defaults it gets Task/Milestone/Summary task and ten modules, and
# both of those hurt: Bug and Feature cannot be filed at all, and every module a project
# switches on lights up another entry in the global sidebar.
#
# Measured on production when another session created one — the pool could not even list
# it. The pool excludes the 交接 type, and filtering on a type a project does not have is
# a 400 from OpenProject, so every read failed, tool and page alike.
pool_type_ids = (requirement_types + [handoff_type]).compact.map(&:id).uniq
Type.where(is_default: true).where.not(id: pool_type_ids).update_all(is_default: false)
Type.where(id: pool_type_ids).where(is_default: false).update_all(is_default: true)

# Requirements and handoffs are both work packages. Nothing else here needs a module, and
# each extra one is another sidebar entry nobody asked for.
#
# docker-compose.override.yml pins this through ENV, because this script does not run on
# deploy and the setting could drift between runs. A pinned setting is read-only: assigning
# it raises Setting::NotWritableError. So it is written only where nothing pins it, and a pin
# to anything else is left alone — someone chose it — but said out loud on stderr, which
# keeps it out of the JSON this script prints.
wanted_modules = ["work_package_tracking"]
if Settings::Definition[:default_projects_modules].writable?
  Setting.default_projects_modules = wanted_modules
elsif Setting.default_projects_modules != wanted_modules
  warn "default_projects_modules is pinned by ENV to #{Setting.default_projects_modules.inspect}, " \
       "not #{wanted_modules.inspect}"
end

status_map = status_maps.fetch("statusHrefs")

# A new type has no workflow, and OpenProject rejects every status change on it with
# "no valid transition exists for the current user's role" — which surfaces as a 422 on
# any attempt to move a handoff through its lifecycle. Copying Task's transitions gives
# the handoff type the same, already-sensible set.
if Workflow.where(type_id: handoff_type.id).none?
  source_type = type
  Workflow.copy(source_type, nil, [handoff_type], nil)
end

handoff_status_map = status_maps.fetch("handoffStatusHrefs")

map = {
  defaultProjectIdentifier: "eva-project",
  typeHref: "/api/v3/types/#{type.id}",
  handoffTypeHref: "/api/v3/types/#{handoff_type.id}",
  requirementTypeHrefs: requirement_types.map { |item| "/api/v3/types/#{item.id}" },
  fields: field_map,
  statusHrefs: status_map,
  handoffStatusHrefs: handoff_status_map,
  handoffCompletionStates: ["已归档", "已作废"],
  completionStates: ["已完成", "已合并"]
}

field_map_tmp = File.join(output_dir, "field-map.json.tmp")
field_map_path = File.join(output_dir, "field-map.json")
File.write(field_map_tmp, JSON.pretty_generate(map))
File.rename(field_map_tmp, field_map_path)

token_path = File.join(output_dir, "openproject-api-token")
token_value = File.exist?(token_path) ? File.read(token_path).strip : nil
valid_token = token_value.present? && Token::API.find_by_plaintext_value(token_value)&.user_id == admin.id
unless valid_token
  Token::API.where(user: admin).where("data ->> 'token_name' = ?", "Eva-Project MCP").delete_all
  token = Token::API.create!(user: admin, token_name: "Eva-Project MCP")
  token_value = token.plain_value
  token_tmp = "#{token_path}.tmp"
  File.write(token_tmp, token_value)
  File.chmod(0o600, token_tmp)
  File.rename(token_tmp, token_path)
end

File.chmod(0o600, token_path)
File.chmod(0o644, field_map_path)

puts JSON.generate({
  ok: true,
  first_run: first_run,
  projects: projects.map { |project| { id: project.id, identifier: project.identifier } },
  type_id: type.id,
  handoff_type_id: handoff_type.id,
  fields: field_map.length
})
