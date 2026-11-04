# Run in the OpenProject container: bundle exec rails runner - < this file.
# Uses the actual User validator without saving users or changing passwords.
evaluator = OpenProject::Passwords::Evaluator
raise "minimum must be 8" unless evaluator.min_length == 8
{
  "abcd1234" => true, "ABCD1234" => true, "a1234567" => true,
  "abc123456789" => true, "a1!@#$%^" => true,
  "12345678" => false, "abcdefgh" => false, "a123456" => false,
  "中文123456" => false, "" => false
}.each do |password, expected|
  raise "evaluator mismatch" unless evaluator.conforming?(password) == expected
  user = User.new
  user.password = password
  user.send(:password_meets_requirements)
  raise "User validator mismatch" unless user.errors[:password].empty? == expected
end
I18n.with_locale(:"zh-CN") do
  hint = ApplicationController.helpers.render_password_requirements.to_s
  raise "hint mismatch" unless hint.include?("8") && hint.include?("字母") && hint.include?("数字")
  raise "stale complexity checklist" if hint.include?("特殊字符") || hint.include?("requirement-type")
end
puts "Password policy: 11 evaluator/User cases and Chinese form hint passed"
