package repository

import (
	"context"
	"time"

	"next-terminal/server/model"
)

var JobLogRepository = new(jobLogRepository)

type jobLogRepository struct {
	baseRepository
}

func (r jobLogRepository) Create(c context.Context, o *model.JobLog) error {
	return r.GetDB(c).Create(o).Error
}

func (r jobLogRepository) FindByJobId(c context.Context, jobId string, pageIndex, pageSize int) (o []model.JobLog, total int64, err error) {

	err = r.GetDB(c).Table("job_logs").Where("job_id = ?", jobId).Count(&total).Error
	if err != nil {
		return nil, 0, err
	}
	err = r.GetDB(c).Where("job_id = ?", jobId).Order("timestamp desc").Offset((pageIndex - 1) * pageSize).Limit(pageSize).Find(&o).Error
	if o == nil {
		o = make([]model.JobLog, 0)
	}
	return
}

func (r jobLogRepository) DeleteByJobId(c context.Context, jobId string) error {
	return r.GetDB(c).Where("job_id = ?", jobId).Delete(model.JobLog{}).Error
}

func (r jobLogRepository) DeleteByIdIn(c context.Context, ids []string) error {
	return r.GetDB(c).Where("id in ?", ids).Delete(&model.JobLog{}).Error
}

// DeleteOutTimeLog 按保留期直接删除，返回删除行数。
// 与 LoginLogRepository.DeleteOutTimeLog 同理：避免把数万个 ID 展开成 SQL 占位符
// （SQLite 的 SQLITE_MAX_VARIABLE_NUMBER 为 32766，超过即报 "too many SQL variables"，
// 清理任务会永远失败且只留告警）。
func (r jobLogRepository) DeleteOutTimeLog(c context.Context, dayLimit int) (int64, error) {
	limitTime := time.Now().Add(time.Duration(-dayLimit*24) * time.Hour)
	result := r.GetDB(c).Where("timestamp < ?", limitTime).Delete(&model.JobLog{})
	return result.RowsAffected, result.Error
}

func (r jobLogRepository) DeleteById(c context.Context, id string) error {
	return r.GetDB(c).Where("id = ?", id).Delete(&model.JobLog{}).Error
}
