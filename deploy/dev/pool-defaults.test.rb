# Run inside the local web container. All fixture writes are rolled back.
require "json"

unless WorkPackage._save_callbacks.count { |callback| callback.filter == :evaproject_unique_waiting_handoff } == 1
  raise "Thread guard is not loaded exactly once; recreate web or use a fresh one-off web container after updating initializers"
end

User.current = User.find_by!(login: "admin")
map = JSON.parse(File.read("/evaproject-runtime/field-map.json"))
field_id = ->(name) { map.fetch("fields").fetch(name).fetch("key").delete_prefix("customField").to_i }
value = ->(item, name) { item.custom_field_values.find { |entry| entry.custom_field_id == field_id.call(name) }&.value }
project = Project.find_by!(identifier: "eva-project")
type = EvaProjectPoolTypes.core_type("task")
status = Status.find(map.fetch("statusHrefs").fetch("待认领").split("/").last)
priority = IssuePriority.find_by(is_default: true) || IssuePriority.first!

ActiveRecord::Base.transaction do
  first = WorkPackage.new(project: project, type: type, author: User.current, status: status, priority: priority, subject: "Rollback default fixture")
  first.save!
  identifier = value.call(first, "requirementId")
  raise "Missing generated identifier" if identifier.blank?
  private_option = map.dig("fields", "visibility", "options", "私有").split("/").last
  raise "Incorrect default visibility" unless value.call(first, "visibility") == private_option
  raise "Missing owner" if value.call(first, "ownerUserId").blank?

  duplicate = WorkPackage.new(project: project, type: type, author: User.current, status: status, priority: priority, subject: "Rollback duplicate fixture")
  duplicate.custom_field_values = { field_id.call("requirementId").to_s => identifier }
  raise "Duplicate identifier was saved" if duplicate.save
  raise "Unexpected validation failure" unless duplicate.errors.full_messages.join.include?("相同的需求 ID")
  handoff_type = Type.find_by!(name: "交接")
  handoff_status = Status.find(map.fetch("handoffStatusHrefs").fetch("待接手").split("/").last)
  awaiting = map.dig("fields", "handoffState", "options", "待接手").split("/").last
  draft = map.dig("fields", "handoffState", "options", "草稿").split("/").last
  archived = map.dig("fields", "handoffState", "options", "已归档").split("/").last
  thread = "rollback-thread-#{SecureRandom.uuid}"
  make_handoff = lambda do |state|
    item = WorkPackage.new(project: project, type: handoff_type, author: User.current,
      status: handoff_status, priority: priority, subject: "Rollback thread fixture")
    item.custom_field_values = { field_id.call("handoffThread").to_s => thread,
      field_id.call("handoffState").to_s => state }
    item
  end
  waiting = make_handoff.call(awaiting)
  waiting.save!
  successor = make_handoff.call(awaiting)
  raise "Duplicate waiting handoff was saved" if successor.save
  raise "Wrong thread validation error" unless successor.errors.full_messages.join.include?("已有待接手交接")
  successor.custom_field_values = { field_id.call("handoffState").to_s => draft }
  successor.save!
  successor.custom_field_values = { field_id.call("handoffState").to_s => awaiting }
  raise "Draft published before archive" if successor.save
  waiting.custom_field_values = { field_id.call("handoffState").to_s => archived }
  waiting.save!
  successor.custom_field_values = { field_id.call("handoffState").to_s => awaiting }
  successor.save!
  raise "Thread changed during staging" unless value.call(successor, "handoffThread") == thread
  raise ActiveRecord::Rollback
end

puts JSON.generate(ok: true, checks: %w[native_defaults private_visibility owner duplicate_identifier unique_waiting_thread draft_successor], rolled_back: true)
