package repository

import (
	"context"
	"time"

	"next-terminal/server/dto"
	"next-terminal/server/model"
)

var StorageLogRepository = new(storageLogRepository)

type storageLogRepository struct {
	baseRepository
}

func (r storageLogRepository) DeleteById(c context.Context, id string) error {
	return r.GetDB(c).Where("id = ?", id).Delete(model.StorageLog{}).Error
}

// DeleteOutTimeLog 按保留期直接删除存储操作日志，返回删除行数。
//
// 存储日志此前完全没有保留期清理：每次上传/下载/删除/重命名/建目录各插一行，
// 永不过期——与 sessions / login_logs / job_logs 三张表的策略不一致，
// 长期运行后成为库中增长最快的表。
func (r storageLogRepository) DeleteOutTimeLog(c context.Context, dayLimit int) (int64, error) {
	limitTime := time.Now().Add(time.Duration(-dayLimit*24) * time.Hour)
	result := r.GetDB(c).Where("created < ?", limitTime).Delete(&model.StorageLog{})
	return result.RowsAffected, result.Error
}

func (r storageLogRepository) DeleteAll(c context.Context) error {
	return r.GetDB(c).Where("1 = 1").Delete(model.StorageLog{}).Error
}

func (r storageLogRepository) Create(c context.Context, m *model.StorageLog) error {
	return r.GetDB(c).Create(m).Error
}

func (r storageLogRepository) FindById(c context.Context, id string) (m model.StorageLog, err error) {
	err = r.GetDB(c).Where("id = ?", id).First(&m).Error
	return
}

func (r storageLogRepository) Find(c context.Context, pageIndex, pageSize int, assetId, userId, action, order, field string) (o []dto.StorageLogForPage, total int64, err error) {
	db := r.GetDB(c).Table("storage_logs").Select("storage_logs.*, assets.name as asset_name, users.nickname as user_name").
		Joins("left join assets on storage_logs.asset_id = assets.id").
		Joins("left join users  on storage_logs.user_id  = users.id")
	dbCounter := r.GetDB(c).Table("storage_logs").
		Joins("left join assets on storage_logs.asset_id = assets.id").
		Joins("left join users  on storage_logs.user_id  = users.id")

	if len(assetId) > 0 {
		db = db.Where("storage_logs.asset_id = ?", assetId)
		dbCounter = dbCounter.Where("storage_logs.asset_id = ?", assetId)
	}

	if len(userId) > 0 {
		db = db.Where("storage_logs.user_id = ?", userId)
		dbCounter = dbCounter.Where("storage_logs.user_id = ?", userId)
	}

	if len(action) > 0 {
		db = db.Where("storage_logs.action = ?", action)
		dbCounter = dbCounter.Where("storage_logs.action = ?", action)
	}

	err = dbCounter.Count(&total).Error
	if err != nil {
		return nil, 0, err
	}

	if order == "" {
		order = "desc"
	} else if order == "ascend" {
		order = "asc"
	} else {
		order = "desc"
	}

	// field 必须白名单归一为字面量：GORM 的 Order() 接收原始 SQL 片段、不做参数化，
	// 直接拼接等于把 ORDER BY 子句交给调用方控制。原实现只在空值时兜底，非空即原样
	// 拼入，构成 SQL 注入（配合错误信息回显可直接做盲注/报错注入）。
	// 同仓其余 repository 均为此写法，唯此处漏改。
	switch field {
	case "asset_name":
		field = "assets.name"
	case "user_name":
		field = "users.nickname"
	case "action":
		field = "storage_logs.action"
	default:
		field = "storage_logs.created"
	}

	err = db.Order(field + " " + order).Offset((pageIndex - 1) * pageSize).Limit(pageSize).Find(&o).Error
	if o == nil {
		o = make([]dto.StorageLogForPage, 0)
	}
	return
}
