# frozen_string_literal: true

# Gives every new project the types a requirement pool needs.
#
# OpenProject decides a new project's types from one instance-wide flag, Type#is_default.
# Nothing sets them per project, and the API v3 project form does not expose types as
# writable at all: a create or an update carrying `_links.types` answers 200 and changes
# nothing, the same silent acceptance that once dropped every 认领范围. Verified on this
# instance -- with is_default narrowed to Task, a create naming all four types came back
# holding only Task.
#
# So a pool created while that flag had drifted came out unusable: a requirement could not
# be filed as a Bug or a Feature, and a handoff had no type to be written as. The failure
# surfaced far from its cause, which is what made it expensive.
#
# deploy/bootstrap/openproject_bootstrap.rb converges is_default, but it does not run on
# deploy, so that flag is not something this system can keep promising. Here the types are
# put on the project itself, which is the only place they take effect, and on every path
# that creates one -- the MCP, the web UI, a seed -- rather than only the one we remembered.

module EvaProjectPoolTypes
  def self.core_names(key)
    @localized_names ||= {}
    [Setting.default_language, "en", "zh-CN"].uniq.filter_map do |locale|
      names = @localized_names[locale] ||= Source::SeedDataLoader.new(locale: locale, only: "types")
        .seed_data.lookup("types").to_h { |row| [row.fetch("reference").to_s, row.fetch("name")] }
      names["default_type_#{key}"]
    end.uniq
  end

  def self.core_type(key)
    core_names(key).each do |name|
      found = Type.find_by(name: name)
      return found if found
    end
    raise ActiveRecord::RecordNotFound, "Required work package type #{key} is missing"
  end

  def self.names
    return ENV.fetch("EVAPROJECT_POOL_TYPES").split(",").map(&:strip).reject(&:empty?) if ENV.key?("EVAPROJECT_POOL_TYPES")
    %w[task feature bug].flat_map { |key| core_names(key) } + ["交接"]
  end
end

Rails.application.config.to_prepare do
  unless WorkPackage.method_defined?(:evaproject_default_pool_fields)
    WorkPackage.class_eval do
      before_validation :evaproject_default_pool_fields, on: :create
      before_save :evaproject_unique_record_id

      def evaproject_unique_record_id
        map_path = "/evaproject-runtime/field-map.json"
        return unless project_id && File.file?(map_path)
        field_id = JSON.parse(File.read(map_path)).dig("fields", "requirementId", "key")&.delete_prefix("customField")&.to_i
        return unless field_id
        identifier = custom_field_values.find { |entry| entry.custom_field_id == field_id }&.value
        return if identifier.blank?
        # All writers, including native work packages and multiple MCP processes,
        # serialize the uniqueness check inside the save transaction.
        lock_id = Digest::SHA256.hexdigest("eva-record:#{project_id}:#{identifier}")[0, 15].to_i(16)
        self.class.connection.select_value("SELECT pg_advisory_xact_lock(#{lock_id})")
        duplicates = self.class.where(project_id: project_id).where.not(id: id)
          .joins(:custom_values).where(custom_values: { custom_field_id: field_id, value: identifier })
        if duplicates.exists?
          errors.add(:base, "此项目已存在相同的需求 ID，请刷新列表确认记录")
          throw :abort
        end
      end

      def evaproject_default_pool_fields
        return unless type && EvaProjectPoolTypes.names.include?(type.name)
        map_path = "/evaproject-runtime/field-map.json"
        return unless File.file?(map_path)
        map = JSON.parse(File.read(map_path))
        values = custom_field_values.group_by(&:custom_field_id).to_h do |id, entries|
          value = entries.first.custom_field.multi_value? ? entries.map(&:value) : entries.first.value
          [id.to_s, value]
        end
        set_default = lambda do |name, value|
          definition = map.fetch("fields")[name]
          next unless definition
          id = definition.fetch("key").delete_prefix("customField")
          next if values[id].present?
          if definition.fetch("kind") == "list"
            href = definition.fetch("options", {})[value]
            next unless href
            value = href.split("/").last
          end
          values[id] = value
        end
        set_default.call("requirementId", "EVA-#{SecureRandom.uuid}")
        set_default.call("visibility", "私有")
        set_default.call("recordedAt", Time.current.iso8601)
        if type.name == "交接"
          set_default.call("handoffState", "草稿")
          set_default.call("handoffExpectedAgent", "不限")
        else
          set_default.call("state", "待认领")
          set_default.call("intakeStatus", "待确认")
          set_default.call("verificationStatus", "未验证")
          set_default.call("userAcceptance", "待确认")
        end
        principal_path = "/evaproject-runtime/mcp/principals.json"
        if User.current&.logged? && File.file?(principal_path)
          principals = JSON.parse(File.read(principal_path)).fetch("principals")
          matches = principals.select do |entry|
            entry["active"] && (entry.key?("openProjectLogin") ? entry["openProjectLogin"] : entry["userId"]) == User.current.login
          end
          if matches.one?
            set_default.call("ownerUserId", matches.first.fetch("userId"))
            set_default.call("requesterId", matches.first.fetch("userId"))
            set_default.call("requesterName", User.current.name)
            set_default.call("requesterType", "人")
          end
        end
        self.custom_field_values = values
      end
    end
  end

  # Save the operation note in the same transaction as the versioned field update.
  # A rejected PATCH must not leave behind a separate success-looking activity.
  unless API::V3::WorkPackages::WorkPackagePayloadRepresenter.method_defined?(:evaproject_atomic_notes)
    API::V3::WorkPackages::WorkPackagePayloadRepresenter.class_eval do
      formattable_property :journal_notes
      def evaproject_atomic_notes = true
    end
    WorkPackages::UpdateContract.attribute :journal_notes, permission: :add_work_package_comments
  end

  # to_prepare runs again on every reload; without the guard the callback stacks up.
  unless Project.method_defined?(:evaproject_apply_pool_types)
    Project.class_eval do
      after_create :evaproject_apply_pool_types

      # Additive on purpose. Taking types away could orphan a work package that already
      # uses one, and the pool only ever needs these to be present, not to be alone.
      def evaproject_apply_pool_types
        wanted = Type.where(name: EvaProjectPoolTypes.names).to_a
        (wanted - types.to_a).each { |type| types << type }
      rescue StandardError => error
        # Never fail the creation itself: a project that exists and is missing a type can
        # be repaired, and the MCP refuses to hand it out as a pool until it is.
        Rails.logger.error("[evaproject] could not apply pool types to #{identifier}: #{error.class}: #{error.message}")
      end
    end
  end
end
