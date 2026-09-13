package repository

import (
	"context"
	"time"

	"next-terminal/server/common/nt"
	"next-terminal/server/dto"
	"next-terminal/server/model"
)

var SessionRepository = new(sessionRepository)

type sessionRepository struct {
	baseRepository
}

func (r sessionRepository) Find(c context.Context, pageIndex, pageSize int, status, userId, clientIp, assetId, protocol, reviewed string) (results []model.SessionForPage, total int64, err error) {

	db := r.GetDB(c)
	var params []interface{}

	params = append(params, status)

	// 在线会话列表（status=connected）同时包含「已断开但 keep_alive=1」的会话：
	// 用户主动断开或断线后，tmux 会话仍在远端运行（24h TTL 内），用户应能从
	// 在线列表点「继续」重连。60s 宽限期后 CloseSessionById 把 status 改为
	// disconnected，若不加此条件，会话从在线列表消失、用户无法重连。
	statusClause := "s.STATUS = ?"
	if status == "connected" {
		statusClause = "(s.STATUS = ? OR (s.STATUS = 'disconnected' AND s.keep_alive = '1'))"
	}

	itemSql := "SELECT s.id,s.mode, s.protocol,s.recording, s.connection_id, s.asset_id, s.creator, s.client_ip, s.width, s.height, s.ip, s.port, s.username, s.status, s.connected_time, s.disconnected_time,s.code,s.reviewed, s.message,s.command_count, s.keep_alive, s.client_type, s.client_name, a.name AS asset_name, u.nickname AS creator_name FROM sessions s " +
		"LEFT JOIN assets a ON s.asset_id = a.id " +
		"LEFT JOIN users u ON s.creator = u.id " +
		"WHERE " + statusClause + " "
	countSql := "select count(*) from sessions as s where " + statusClause + " "

	if len(userId) > 0 {
		itemSql += " and s.creator = ?"
		countSql += " and s.creator = ?"
		params = append(params, userId)
	}

	if len(clientIp) > 0 {
		itemSql += " and s.client_ip like ?"
		countSql += " and s.client_ip like ?"
		params = append(params, "%"+clientIp+"%")
	}

	if len(assetId) > 0 {
		itemSql += " and s.asset_id = ?"
		countSql += " and s.asset_id = ?"
		params = append(params, assetId)
	}

	if len(protocol) > 0 {
		itemSql += " and s.protocol = ?"
		countSql += " and s.protocol = ?"
		params = append(params, protocol)
	}

	if reviewed != "" {
		bReviewed := reviewed == "true"
		itemSql += " and s.reviewed = ?"
		countSql += " and s.reviewed = ?"
		params = append(params, bReviewed)
	}

	db.Raw(countSql, params...).Find(&total)

	params = append(params, (pageIndex-1)*pageSize, pageSize)
	itemSql += " order by s.connected_time desc LIMIT ?, ?"

	err = db.Raw(itemSql, params...).Find(&results).Error

	if results == nil {
		results = make([]model.SessionForPage, 0)
	}
	return
}

func (r sessionRepository) FindByStatus(c context.Context, status string) (o []model.Session, err error) {
	// 仅取主键：两个调用方（FixSessionState 批量改状态、ClearOfflineSession 收集待删 ID）
	// 都只用 ID。整行读回会把 password / private_key 等加密大列一并载入，
	// 而 sessions 按年累积，离线会话可达数万行。
	err = r.GetDB(c).Select("id").Where("status = ?", status).Find(&o).Error
	return
}

func (r sessionRepository) FindByStatusIn(c context.Context, statuses []string) (o []model.Session, err error) {
	err = r.GetDB(c).Where("status in ?", statuses).Find(&o).Error
	return
}

// FindOutTimeSessionIds 分批取过期离线会话的 ID（每批 limit 条）。
//
// 清理任务必须拿到 ID 才能删除对应的录屏文件，但一次性捞回数万个 ID 会同时
// 撑爆内存与 SQL 参数上限（SQLite 的 SQLITE_MAX_VARIABLE_NUMBER 为 32766）。
// 调用方循环取批直到返回空，即可把单次 IN 控制在可控规模内。
func (r sessionRepository) FindOutTimeSessionIds(c context.Context, dayLimit, limit int) (ids []string, err error) {
	limitTime := time.Now().Add(time.Duration(-dayLimit*24) * time.Hour)
	err = r.GetDB(c).
		Model(&model.Session{}).
		Where("status = ? and connected_time < ?", nt.Disconnected, limitTime).
		Limit(limit).
		Pluck("id", &ids).Error
	return
}

func (r sessionRepository) Create(c context.Context, o *model.Session) (err error) {
	err = r.GetDB(c).Create(o).Error
	return
}

func (r sessionRepository) FindById(c context.Context, id string) (o model.Session, err error) {
	err = r.GetDB(c).Where("id = ?", id).First(&o).Error
	return
}

func (r sessionRepository) FindByConnectionId(c context.Context, connectionId string) (o model.Session, err error) {
	err = r.GetDB(c).Where("connection_id = ?", connectionId).First(&o).Error
	return
}

func (r sessionRepository) UpdateById(c context.Context, o *model.Session, id string) error {
	o.ID = id
	return r.GetDB(c).Updates(o).Error
}

func (r sessionRepository) UpdateWindowSizeById(c context.Context, width, height int, id string) error {
	session := model.Session{}
	session.Width = width
	session.Height = height

	return r.UpdateById(c, &session, id)
}

func (r sessionRepository) DeleteById(c context.Context, id string) error {
	return r.GetDB(c).Where("id = ?", id).Delete(&model.Session{}).Error
}

func (r sessionRepository) DeleteByIds(c context.Context, ids []string) error {
	return r.GetDB(c).Where("id IN ?", ids).Delete(&model.Session{}).Error
}

func (r sessionRepository) DeleteByStatus(c context.Context, status string) error {
	return r.GetDB(c).Where("status = ?", status).Delete(&model.Session{}).Error
}

func (r sessionRepository) CountOnlineSession(c context.Context) (total int64, err error) {
	err = r.GetDB(c).Model(&model.Session{}).Where("status = ?", nt.Connected).Count(&total).Error
	return
}

func (r sessionRepository) CountOfflineSession(c context.Context) (total int64, err error) {
	err = r.GetDB(c).Model(&model.Session{}).Where("status = ?", nt.Disconnected).Count(&total).Error
	return
}

func (r sessionRepository) EmptyPassword(c context.Context) error {
	sql := "update sessions set password = '-',private_key = '-', passphrase = '-' where 1=1"
	return r.GetDB(c).Exec(sql).Error
}

func (r sessionRepository) CountByStatus(c context.Context, status string) (total int64, err error) {
	err = r.GetDB(c).Model(&model.Session{}).Where("status = ?", status).Count(&total).Error
	return
}

func (r sessionRepository) UpdateReadByIds(c context.Context, reviewed bool, ids []string) error {
	sql := "update sessions set reviewed = ? where id in ?"
	return r.GetDB(c).Exec(sql, reviewed, ids).Error
}

func (r sessionRepository) FindAllUnReviewed(c context.Context) (o []model.Session, err error) {
	// 仅取主键：调用方只用 ID 做后续批量标记
	err = r.GetDB(c).Select("id").Where("reviewed = false or reviewed is null").Find(&o).Error
	return
}

// MarkAllReviewed 一次性把全部未审查会话标记为已审查，返回影响行数。
//
// 替代「查出全部未审查 ID → 分批 UpdateReadByIds」的写法：后者要先把数万行
// 读进内存，再发出数百条 UPDATE，且分批边界处理容易出错。这里一条 UPDATE 完成。
func (r sessionRepository) MarkAllReviewed(c context.Context, reviewed bool) (int64, error) {
	result := r.GetDB(c).
		Model(&model.Session{}).
		Where("reviewed = false or reviewed is null").
		Update("reviewed", reviewed)
	return result.RowsAffected, result.Error
}

func (r sessionRepository) UpdateMode(c context.Context) error {
	sql := "update sessions set mode = 'native' where mode = 'naive'"
	return r.GetDB(c).Exec(sql).Error
}

func (r sessionRepository) CountWithGroupByLoginTime(c context.Context, t time.Time) (counter []dto.DateCounter, err error) {
	err = r.GetDB(c).Table("sessions").Select("date(connected_time) as date, count(id) as value").Where("connected_time > ?", t).Group("date(connected_time)").Scan(&counter).Error
	return
}

// FindKeepAliveExpired 查「启用会话保持、已断开、且断开超过 cutoff」的会话（TTL 清理用）。
func (r sessionRepository) FindKeepAliveExpired(c context.Context, cutoff time.Time) ([]model.Session, error) {
	var items []model.Session
	err := r.GetDB(c).
		Where("keep_alive = ? AND status = ? AND disconnected_time IS NOT NULL AND disconnected_time < ?", "1", nt.Disconnected, cutoff).
		Order("disconnected_time asc").
		Find(&items).Error
	if items == nil {
		items = make([]model.Session, 0)
	}
	return items, err
}
