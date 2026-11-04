# frozen_string_literal: true

# One awaiting handoff per project/thread, including writes from other workers.
Rails.application.config.to_prepare do
  unless WorkPackage.method_defined?(:evaproject_unique_waiting_handoff)
    WorkPackage.class_eval do
      before_save :evaproject_unique_waiting_handoff
      # The transaction lock also covers writers from other MCP workers and the
      # native UI. Draft successors do not become claimable until their predecessor
      # has been archived; failure leaves an explicit, recoverable draft.
      def evaproject_unique_waiting_handoff
        return unless project_id && type&.name == "交接"
        map_path = "/evaproject-runtime/field-map.json"
        return unless File.file?(map_path)
        fields = JSON.parse(File.read(map_path)).fetch("fields")
        thread_id = fields.dig("handoffThread", "key")&.delete_prefix("customField")&.to_i
        state_id = fields.dig("handoffState", "key")&.delete_prefix("customField")&.to_i
        awaiting = fields.dig("handoffState", "options", "待接手")&.split("/")&.last
        return unless thread_id && state_id && awaiting
        values = custom_field_values
        state = values.find { |entry| entry.custom_field_id == state_id }&.value
        thread = values.find { |entry| entry.custom_field_id == thread_id }&.value
        return unless state.to_s == awaiting && thread.present?
        lock_id = Digest::SHA256.hexdigest("eva-handoff-thread:#{project_id}:#{thread}")[0, 15].to_i(16)
        self.class.connection.select_value("SELECT pg_advisory_xact_lock(#{lock_id})")
        waiting = self.class.joins(:custom_values)
          .where(custom_values: { custom_field_id: state_id, value: awaiting }).select(:id)
        duplicates = self.class.where(project_id: project_id, type_id: type_id).where.not(id: id)
          .joins(:custom_values).where(custom_values: { custom_field_id: thread_id, value: thread })
          .where(id: waiting)
        if duplicates.exists?
          errors.add(:base, "此线程已有待接手交接，请刷新后确认")
          throw :abort
        end
      end

    end
  end

end
