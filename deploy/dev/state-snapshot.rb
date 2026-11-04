# frozen_string_literal: true
#
# Read-only snapshot of everything the handoff upgrade could plausibly damage.
#
# Writes nothing and changes nothing, so it is safe to run against the production
# instance as well as the local one. Pair it with state-diff.py: take a snapshot
# before the upgrade, one after, and let the differ decide whether the difference is
# exactly the additive change the runbook promises.
#
#   compose exec -T web bundle exec rails runner - < deploy/dev/state-snapshot.rb > before.json
#
# Counting rows is not enough on its own: a bootstrap bug that wiped one custom field's
# values would leave every work package count untouched. So this also records, per
# custom field, how many work packages actually carry a value, plus a digest over the
# work package rows themselves.

require "json"
require "digest"

def digest_rows(rows)
  Digest::SHA256.hexdigest(rows.map { |row| row.join("\x1f") }.join("\x1e"))
end

types = Type.order(:id).to_a
projects = Project.order(:id).to_a
custom_fields = WorkPackageCustomField.order(:id).to_a

type_name_by_id = types.to_h { |type| [type.id, type.name] }
status_name_by_id = Status.order(:id).to_h { |status| [status.id, status.name] }
project_identifier_by_id = projects.to_h { |project| [project.id, project.identifier] }

work_package_rows = WorkPackage.order(:id).pluck(:id, :type_id, :status_id, :project_id, :subject)

snapshot = {
  schema: 1,
  captured_at: Time.now.utc.iso8601,
  instance: {
    host_name: Setting.host_name,
    openproject_version: OpenProject::VERSION.to_s
  },

  work_packages: {
    total: work_package_rows.length,
    max_id: work_package_rows.map(&:first).max,
    # Catches any mutation of an existing record, not just a change in how many there are.
    digest: digest_rows(work_package_rows),
    by_type: work_package_rows.group_by { |row| type_name_by_id[row[1]] }
                              .transform_values(&:length),
    by_status: work_package_rows.group_by { |row| status_name_by_id[row[2]] }
                                .transform_values(&:length),
    by_project: work_package_rows.group_by { |row| project_identifier_by_id[row[3]] }
                                 .transform_values(&:length)
  },

  projects: projects.to_h do |project|
    [project.identifier, {
      id: project.id,
      name: project.name,
      active: project.active?,
      types: project.types.order(:id).pluck(:name)
    }]
  end,

  types: types.to_h do |type|
    [type.name, {
      id: type.id,
      is_default: type.is_default,
      is_milestone: type.is_milestone,
      # A type with no workflow rejects every status change with a 422.
      workflow_count: Workflow.where(type_id: type.id).count
    }]
  end,

  statuses: Status.order(:id).to_h { |status| [status.name, { id: status.id, is_closed: status.is_closed }] },

  custom_fields: custom_fields.to_h do |field|
    [field.name, {
      id: field.id,
      format: field.field_format,
      multi_value: field.multi_value,
      is_required: field.is_required,
      is_for_all: field.is_for_all,
      # Which forms show the field. Losing an entry here silently hides data.
      types: field.types.order(:id).pluck(:name),
      projects: field.projects.order(:id).pluck(:identifier),
      # Order matters: the differ checks that existing options keep their relative order.
      options: field.custom_options.order(:position).pluck(:value),
      # The real data-loss detector.
      values_present: CustomValue.where(custom_field_id: field.id, customized_type: "WorkPackage")
                                 .where.not(value: [nil, ""]).count
    }]
  end,

  attachments: {
    total: Attachment.count,
    bytes: Attachment.sum(:filesize).to_i,
    digest: digest_rows(Attachment.order(:id).pluck(:id, :container_type, :container_id, :filename, :filesize))
  },

  queries: {
    total: Query.count,
    global: Query.where(project_id: nil).order(:id).pluck(:name),
    by_project: Query.where.not(project_id: nil).group(:project_id).count
                     .transform_keys { |id| project_identifier_by_id[id] || "project:#{id}" }
  },

  users: {
    total: User.count,
    # id:login, not login alone: OpenProject's built-in system, anonymous and deleted
    # placeholder users all have a blank login, and a set comparison would collapse them.
    logins: User.order(:id).pluck(:id, :login).map { |id, login| "#{id}:#{login}" }
  },

  members: Member.count,

  settings: {
    work_package_list_default_columns: Setting.work_package_list_default_columns,
    demo_projects_available: Setting.demo_projects_available,
    boards_demo_data_available: Setting.boards_demo_data_available,
    # Digested, not quoted: the point is only whether a rerun overwrote it.
    welcome_text_digest: Digest::SHA256.hexdigest(Setting.welcome_text.to_s),
    welcome_text_length: Setting.welcome_text.to_s.length
  }
}

puts JSON.pretty_generate(snapshot)
