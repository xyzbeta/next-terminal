package common

import (
	otp_t "github.com/pquerna/otp"
	totp_t "github.com/pquerna/otp/totp"
)

type GenerateOpts totp_t.GenerateOpts

func NewTOTP(opt GenerateOpts) (*otp_t.Key, error) {
	return totp_t.Generate(totp_t.GenerateOpts(opt))
}

// Validate 校验 TOTP 授权码。
//
// 采用 fail-close：secret 为空或未启用（"-"）一律判定失败，由调用方显式处理
// 「该账号未开启两步验证」分支——现有三处调用点（Web 登录、SSH 终端登录、
// 确认绑定）都已在调用前判断 TOTPSecret，故此处不会影响未启用 2FA 的用户。
//
// 原实现 secret == "" 时返回 true：一旦未来新增调用点漏掉前置守卫，
// 即构成双因素认证被完全绕过。
func Validate(code string, secret string) bool {
	if secret == "" || secret == "-" {
		return false
	}
	return totp_t.Validate(code, secret)
}
