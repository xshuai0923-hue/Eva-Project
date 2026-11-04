# Enable classification without rerunning the initial data bootstrap.
require "json"

map_path = ENV.fetch("EVAPROJECT_FIELD_MAP_PATH", "/evaproject-runtime/field-map.json")
field_ids = JSON.parse(File.read(map_path)).fetch("fields").values.map { |field| field.fetch("key").delete_prefix("customField").to_i }
projects = %w[eva-project].map { |identifier| Project.find_by!(identifier: identifier) }
types = %w[task bug feature].map { |key| EvaProjectPoolTypes.core_type(key) }

ActiveRecord::Base.transaction do
  projects.each do |project|
    types.each { |type| project.types << type unless project.types.exists?(type.id) }
  end
  WorkPackageCustomField.where(id: field_ids).each do |field|
    types.each { |type| field.types << type unless field.types.exists?(type.id) }
  end
  columns = Setting.work_package_list_default_columns.map(&:to_s)
  columns.insert((columns.index("subject") || 0) + 1, "type") unless columns.include?("type")
  Setting.work_package_list_default_columns = columns
end

puts JSON.generate(projects: projects.map(&:identifier), types: types.map { |type| { id: type.id, name: type.name } })
