package model

import (
	"next-terminal/server/common"
)

type LoginLog struct {
	ID              string          `gorm:"primary_key,type:varchar(128)" json:"id"`
	Username        string          `gorm:"index,type:varchar(200)" json:"username"`
	ClientIP        string          `gorm:"type:varchar(200)" json:"clientIp"`
	ClientUserAgent string          `gorm:"type:varchar(500)" json:"clientUserAgent"`
	LoginTime       common.JsonTime `gorm:"index" json:"loginTime"`
	LogoutTime      common.JsonTime `gorm:"index" json:"logoutTime"`
	Remember        bool            `json:"remember"`
	State           string          `gorm:"index,type:varchar(1)" json:"state"` // 成功 1 失败 0
	Reason          string          `gorm:"type:varchar(500)" json:"reason"`
}

func (r *LoginLog) TableName() string {
	return "login_logs"
}
