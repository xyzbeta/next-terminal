package task

import (
	"context"
	"fmt"
	"github.com/shirou/gopsutil/v3/load"
	"next-terminal/server/common/nt"
	"next-terminal/server/common/term"
	"next-terminal/server/model"
	"next-terminal/server/service"
	"next-terminal/server/utils"
	"strconv"
	"time"

	"next-terminal/server/log"
	"next-terminal/server/repository"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
	"next-terminal/server/global/stat"
)

// recoverPanic 定时任务 goroutine panic 兜底，防止单点 panic 击穿进程
func recoverPanic(name string) {
	if err := recover(); err != nil {
		log.Error("ticker goroutine panic", log.String("name", name), log.String("panic", fmt.Sprintf("%v", err)))
	}
}

type Ticker struct {
}

func NewTicker() *Ticker {
	return &Ticker{}
}

func (t *Ticker) SetupTicker() {

	// 每隔一小时删除一次未使用的会话信息
	unUsedSessionTicker := time.NewTicker(time.Minute * 60)
	go func() {
		defer recoverPanic("deleteUnUsedSession")
		for range unUsedSessionTicker.C {
			t.deleteUnUsedSession()
		}
	}()

	// 每隔6小时删除超过时长限制的会话
	timeoutSessionTicker := time.NewTicker(time.Hour * 6)
	go func() {
		defer recoverPanic("deleteOutTime")
		for range timeoutSessionTicker.C {
			deleteOutTimeSession()
			deleteOutTimeLoginLog()
			deleteOutTimeJobLog()
			deleteOutTimeStorageLog()
		}
	}()

	// 每隔10分钟清理「断开超 TTL 的会话保持会话」：远程 kill tmux，防止无人认领的进程泄漏。
	// 启动时立即跑一轮：服务可能停过很久，期间的过期会话在启动后马上清理。
	go func() {
		defer recoverPanic("cleanupKeepAlive")
		cleanupKeepAliveSessions()
		keepAliveCleaner := time.NewTicker(time.Minute * 10)
		defer keepAliveCleaner.Stop()
		for range keepAliveCleaner.C {
			cleanupKeepAliveSessions()
		}
	}()

	systemLoader := time.NewTicker(time.Second * 5)
	go func() {
		defer recoverPanic("systemLoad")
		for range systemLoader.C {
			err := systemLoad()
			if err != nil {
				log.Error("采集系统负载失败", log.NamedError("err", err))
			}
		}
	}()
}

func systemLoad() error {
	// 采样阶段：全部 gopsutil 调用都在锁外完成。
	//
	// 原实现用 defer 把整个函数包在写锁里，其中 cpu.Percent(time.Second, false)
	// 是固定 1 秒的阻塞采样，加上 4 次 IOCounters、disk.Usage、VirtualMemory，
	// 临界区长达约 1.1 秒；而采集每 5 秒一次，读侧（前端 Monitoring 5s 轮询
	// /overview/ps）约 21% 的请求会撞上这把锁、平均多等 0.5 秒。
	//
	// 下面的局部变量在锁外算好后，仅用最后一段极短的临界区提交到共享对象。
	beforeBytesRead, beforeBytesWrite, err := ioCounter()
	if err != nil {
		return err
	}

	beforeBytesSent, beforeBytesRecv, err := netCounter()
	if err != nil {
		return err
	}

	percent, err := cpu.Percent(time.Second, false)
	if err != nil {
		return err
	}

	afterBytesSent, afterBytesRecv, err := netCounter()
	if err != nil {
		return err
	}

	afterBytesRead, afterBytesWrite, err := ioCounter()
	if err != nil {
		return err
	}

	now := time.Now().Format("15:04:05")

	usage, err := disk.Usage("/")
	if err != nil {
		return err
	}

	avgStat, err := load.Avg()
	if err != nil {
		return err
	}

	memoryStat, err := mem.VirtualMemory()
	if err != nil {
		return err
	}

	// cpu.Counts / cpu.Info 只在首次采样时需要，此处先探测。
	// 用独立的 needCpuInfo 标记而不是判 cpuInfo != nil——cpu.Info() 返回空列表时
	// 切片仍为 nil，会让 CPU 核数一直停在 0，后续 LoadStat.Percent 除零得到 +Inf。
	cpuCount, phyCpuCount := 0, 0
	var cpuInfo []*stat.CpuInfo
	needCpuInfo := stat.SystemLoad.Cpu.Count == 0
	if needCpuInfo {
		if cpuCount, err = cpu.Counts(true); err != nil {
			return err
		}
		if phyCpuCount, err = cpu.Counts(false); err != nil {
			return err
		}
		infoStats, err := cpu.Info()
		if err != nil {
			return err
		}
		for _, info := range infoStats {
			cpuInfo = append(cpuInfo, &stat.CpuInfo{
				ModelName: info.ModelName,
				CacheSize: info.CacheSize,
				MHZ:       info.Mhz,
			})
		}
	}

	// 提交阶段：仅内存赋值，临界区微秒级
	stat.SystemLoadMutex.Lock()
	defer stat.SystemLoadMutex.Unlock()

	stat.SystemLoad.Disk.Total = usage.Total
	stat.SystemLoad.Disk.Used = usage.Used
	stat.SystemLoad.Disk.Available = usage.Total - usage.Used
	stat.SystemLoad.Disk.UsedPercent = float64(usage.Used) * 100 / float64(usage.Total)

	if needCpuInfo {
		stat.SystemLoad.Cpu.Count = cpuCount
		stat.SystemLoad.Cpu.PhyCount = phyCpuCount
		stat.SystemLoad.Cpu.Info = cpuInfo
	}

	cpuTotal := stat.SystemLoad.Cpu.Count
	stat.SystemLoad.Cpu.UsedPercent = percent[0]

	stat.SystemLoad.CpuStat = append(stat.SystemLoad.CpuStat, stat.NewStat(now, utils.Decimal(stat.SystemLoad.Cpu.UsedPercent)))
	if len(stat.SystemLoad.CpuStat) > 30 {
		stat.SystemLoad.CpuStat = stat.SystemLoad.CpuStat[1:]
	}

	stat.SystemLoad.LoadStat = &stat.LoadStat{
		Load1:   avgStat.Load1,
		Load5:   avgStat.Load5,
		Load15:  avgStat.Load15,
		Percent: avgStat.Load1 / float64(cpuTotal),
	}

	stat.SystemLoad.Mem.Total = memoryStat.Total
	stat.SystemLoad.Mem.Available = memoryStat.Available
	stat.SystemLoad.Mem.Used = memoryStat.Used
	stat.SystemLoad.Mem.UsedPercent = memoryStat.UsedPercent

	stat.SystemLoad.MemStat = append(stat.SystemLoad.MemStat, stat.NewStat(now, utils.Decimal(stat.SystemLoad.Mem.UsedPercent)))
	if len(stat.SystemLoad.MemStat) > 30 {
		stat.SystemLoad.MemStat = stat.SystemLoad.MemStat[1:]
	}

	stat.SystemLoad.DiskIOStat = append(stat.SystemLoad.DiskIOStat, stat.NewIOStat(now, afterBytesRead-beforeBytesRead, afterBytesWrite-beforeBytesWrite))
	if len(stat.SystemLoad.DiskIOStat) > 30 {
		stat.SystemLoad.DiskIOStat = stat.SystemLoad.DiskIOStat[1:]
	}

	stat.SystemLoad.NetIOStat = append(stat.SystemLoad.NetIOStat, stat.NewIOStat(now, afterBytesRecv-beforeBytesRecv, afterBytesSent-beforeBytesSent))
	if len(stat.SystemLoad.NetIOStat) > 30 {
		stat.SystemLoad.NetIOStat = stat.SystemLoad.NetIOStat[1:]
	}

	return nil
}

func ioCounter() (bytesRead, bytesWrite uint64, err error) {
	diskIO, err := disk.IOCounters()
	if err != nil {
		return 0, 0, err
	}
	for _, v := range diskIO {
		bytesRead += v.ReadBytes
		bytesWrite += v.WriteBytes
	}

	return bytesRead, bytesWrite, nil
}

func netCounter() (bytesSent, bytesRecv uint64, err error) {
	netIO, err := net.IOCounters(true)
	if err != nil {
		return 0, 0, err
	}
	for _, v := range netIO {
		bytesSent += v.BytesSent
		bytesRecv += v.BytesRecv
	}
	return bytesSent, bytesRecv, nil
}

func (t *Ticker) deleteUnUsedSession() {
	sessions, err := repository.SessionRepository.FindByStatusIn(context.TODO(), []string{nt.NoConnect, nt.Connecting})
	if err != nil {
		log.Error("查询会话列表失败", log.NamedError("err", err))
		return
	}
	if len(sessions) > 0 {
		now := time.Now()
		var ids []string
		for i := range sessions {
			if now.Sub(sessions[i].ConnectedTime.Time) > time.Hour*1 {
				ids = append(ids, sessions[i].ID)
			}
		}
		if len(ids) > 0 {
			_ = repository.SessionRepository.DeleteByIds(context.TODO(), ids)
		}
	}
}

// deleteOutTimeSession 清理超出保留期的离线会话。
//
// 会话带录屏文件，删行前必须拿到 ID，无法像纯日志表那样一条区间 DELETE 了事。
// 因此改为「分批取 ID → 删行+删录屏」循环，单批 500 条：
//   - 避免一次捞出数万个 ID（内存）并展开成 SQL 占位符（SQLite 上限 32766）
//   - 单批失败即终止，不会无限重试；下一轮 tick 会从断点继续
func deleteOutTimeSession() {
	property, err := repository.PropertyRepository.FindByName(context.TODO(), "session-saved-limit")
	if err != nil {
		return
	}
	if property.Value == "" || property.Value == "-" {
		return
	}
	dayLimit, err := strconv.Atoi(property.Value)
	if err != nil {
		return
	}

	const batchSize = 500
	for {
		ids, err := repository.SessionRepository.FindOutTimeSessionIds(context.TODO(), dayLimit, batchSize)
		if err != nil {
			log.Error("查询过期会话失败", log.NamedError("err", err))
			return
		}
		if len(ids) == 0 {
			return
		}
		if err := service.SessionService.DeleteByIds(context.TODO(), ids); err != nil {
			log.Error("删除离线会话失败", log.Int("count", len(ids)), log.NamedError("err", err))
			return
		}
		if len(ids) < batchSize {
			return
		}
	}
}

func deleteOutTimeLoginLog() {
	property, err := repository.PropertyRepository.FindByName(context.TODO(), "login-log-saved-limit")
	if err != nil {
		return
	}
	if property.Value == "" || property.Value == "-" {
		return
	}
	dayLimit, err := strconv.Atoi(property.Value)
	if err != nil {
		log.Warn("获取删除登录日志保留时常失败", log.NamedError("err", err))
		return
	}

	// 一条区间 DELETE 完成，不再「先查全部 ID 再 IN 删除」：
	// 后者在超过 32766 行时必然报 too many SQL variables，清理任务永远失败。
	deleted, err := repository.LoginLogRepository.DeleteOutTimeLog(context.TODO(), dayLimit)
	if err != nil {
		log.Warn("批量删除登录日志失败", log.NamedError("err", err))
		return
	}
	if deleted > 0 {
		log.Debug("已清理过期登录日志", log.Int64("count", deleted))
	}
}

func deleteOutTimeJobLog() {
	property, err := repository.PropertyRepository.FindByName(context.TODO(), "cron-log-saved-limit")
	if err != nil {
		return
	}
	if property.Value == "" || property.Value == "-" {
		return
	}
	dayLimit, err := strconv.Atoi(property.Value)
	if err != nil {
		return
	}

	deleted, err := repository.JobLogRepository.DeleteOutTimeLog(context.TODO(), dayLimit)
	if err != nil {
		log.Error("批量删除计划日志失败", log.NamedError("err", err))
		return
	}
	if deleted > 0 {
		log.Debug("已清理过期计划日志", log.Int64("count", deleted))
	}
}

func deleteOutTimeStorageLog() {
	property, err := repository.PropertyRepository.FindByName(context.TODO(), "storage-log-saved-limit")
	if err != nil {
		return
	}
	if property.Value == "" || property.Value == "-" {
		return
	}
	dayLimit, err := strconv.Atoi(property.Value)
	if err != nil {
		return
	}

	deleted, err := repository.StorageLogRepository.DeleteOutTimeLog(context.TODO(), dayLimit)
	if err != nil {
		log.Error("批量删除存储日志失败", log.NamedError("err", err))
		return
	}
	if deleted > 0 {
		log.Debug("已清理过期存储日志", log.Int64("count", deleted))
	}
}

// cleanupKeepAliveSessions 清理断开超时的「会话保持（tmux）」会话。
//
// 语义：用户断开/断网后 tmux 会话保留以便重连 attach；但若用户永不再连，
// 远端 tmux 进程（及其中的长任务）会永久泄漏。本任务对 disconnected 超过
// keep-alive-ttl 小时（默认 24，<=0 表示永久保留不清理）的会话，
// 用资产凭证重新 SSH 上去 kill-session。
//
// 幂等标记：kill 成功后把 sessions.keep_alive 置 "0" —— 既是「已处理」标记，
// 也是「该会话不再具备恢复能力」的语义。kill 失败（资产凭证失效、网络不通）
// 保留标记，下一轮重试。
func cleanupKeepAliveSessions() {
	ctx := context.TODO()

	ttlHours := 24
	if p, err := repository.PropertyRepository.FindByName(ctx, nt.KeepAliveTTL); err == nil && p.Value != "" {
		if v, err2 := strconv.Atoi(p.Value); err2 == nil {
			ttlHours = v
		}
	}
	if ttlHours <= 0 {
		return
	}
	cutoff := time.Now().Add(-time.Duration(ttlHours) * time.Hour)

	sessions, err := repository.SessionRepository.FindKeepAliveExpired(ctx, cutoff)
	if err != nil {
		log.Warn("查询待清理的会话保持会话失败", log.NamedError("err", err))
		return
	}
	if len(sessions) == 0 {
		return
	}
	log.Info("清理断开超时的会话保持会话", log.Int("count", len(sessions)))

	for i := range sessions {
		s := sessions[i]
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Warn("清理会话保持会话 panic", log.String("sessionId", s.ID), log.Any("recover", r))
				}
			}()

			// 资产已删除（assetId 为空或 '-'）无法再连：直接标记，避免每轮徒劳重试
			if s.AssetId == "" || s.AssetId == "-" {
				_ = repository.SessionRepository.UpdateById(ctx, &model.Session{KeepAlive: "0"}, s.ID)
				return
			}

			asset, err := service.AssetService.FindByIdAndDecrypt(ctx, s.AssetId)
			if err != nil || asset.ID == "" {
				return // 下次重试
			}
			client, err := term.NewSshClient(s.IP, s.Port, asset.Username, asset.Password, asset.PrivateKey, asset.Passphrase)
			if err != nil {
				return // 网络/凭证问题，下次重试
			}
			defer client.Close()
			if err := term.KillTmux(client, s.ID); err != nil {
				log.Warn("kill tmux 失败（下一轮重试）", log.String("sessionId", s.ID), log.NamedError("err", err))
				return
			}
			_ = repository.SessionRepository.UpdateById(ctx, &model.Session{KeepAlive: "0"}, s.ID)
			log.Info("会话保持会话已清理", log.String("sessionId", s.ID))
		}()
	}
}
