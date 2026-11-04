# frozen_string_literal: true

# One policy for account creation, password changes and password recovery. OpenProject's
# built-in lowercase rule rejects uppercase-only letters, so combine both cases here.
module EvaprojectPasswordPolicy
  def known_rules
    %w[letters numeric]
  end

  def active_rules
    known_rules
  end

  def active_rule?(rule)
    active_rules.include?(rule.to_s)
  end

  def size_active_rules_adhered_by(password)
    [/[A-Za-z]/, /[0-9]/].count { |pattern| password.to_s.match?(pattern) }
  end

  def active_rules_list
    I18n.locale.to_s.start_with?("zh") ? %w[字母 数字] : %w[letter digit]
  end

  def min_length
    8
  end

  def password_conforms_to_rules(password)
    password.to_s.match?(/[A-Za-z]/) && password.to_s.match?(/[0-9]/)
  end

  def rules_description
    I18n.locale.to_s.start_with?("zh") ? "必须同时包含字母和数字" : "Must contain both a letter and a digit"
  end
end

module EvaprojectPasswordHint
  def render_password_requirements
    text = if I18n.locale.to_s.start_with?("zh")
             "至少 8 位，必须同时包含字母和数字（字母大小写均可）。"
           else
             "At least 8 characters, including a letter (either case) and a digit."
           end
    # The upstream live checklist only knows separate uppercase/lowercase rules. A
    # plain caption avoids showing a red lowercase requirement for a valid uppercase
    # password; the shared User validator is authoritative on every submission.
    content_tag(:span, text, class: "evaproject-password-hint")
  end
end

Rails.application.config.to_prepare do
  I18n.backend.store_translations(:"zh-CN", label_password_rule_letters: "字母（大小写均可）")
  I18n.backend.store_translations(:en, label_password_rule_letters: "Letter (either case)")
  evaluator = OpenProject::Passwords::Evaluator.singleton_class
  evaluator.prepend(EvaprojectPasswordPolicy) unless evaluator < EvaprojectPasswordPolicy
  ApplicationHelper.prepend(EvaprojectPasswordHint) unless ApplicationHelper < EvaprojectPasswordHint
end
