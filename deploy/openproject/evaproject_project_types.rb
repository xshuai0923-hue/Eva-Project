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
