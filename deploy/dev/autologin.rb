# Mints an autologin token so browser automation needs no password.
# Local test instance only.
admin = User.find_by!(login: "admin")
Setting.autologin = 1 if Setting.autologin.to_i.zero?
Token::AutoLogin.where(user: admin).destroy_all
token = Token::AutoLogin.create!(user: admin)
puts JSON.generate({
  cookie_name: OpenProject::Configuration["autologin_cookie_name"],
  value: token.plain_value,
  user: admin.login
})
