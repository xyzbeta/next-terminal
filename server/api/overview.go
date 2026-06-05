package api

import (
	"context"
	"next-terminal/server/common/nt"
	"next-terminal/server/dto"
	"next-terminal/server/global/stat"
	"next-terminal/server/repository"
	"time"

	"github.com/labstack/echo/v4"
)

type OverviewApi struct{}

func (api OverviewApi) OverviewCounterEndPoint(c echo.Context) error {
	var (
		totalUser           int64
		onlineUser          int64
		countOfflineSession int64
		totalAsset          int64
		activeAsset         int64
		failLoginCount      int64
	)
	totalUser, _ = repository.UserRepository.Count(context.TODO())
	onlineUser, _ = repository.UserRepository.CountOnlineUser(context.TODO())
	countOfflineSession, _ = repository.SessionRepository.CountOfflineSession(context.TODO())
	totalAsset, _ = repository.AssetRepository.Count(context.TODO())
	activeAsset, _ = repository.AssetRepository.CountByActive(context.TODO(), true)
	failLoginCount, _ = repository.LoginLogRepository.CountByState(context.TODO(), "0")

	counter := dto.Counter{
		TotalUser:      totalUser,
		OnlineUser:     onlineUser,
		OfflineSession: countOfflineSession,
		TotalAsset:     totalAsset,
		ActiveAsset:    activeAsset,
		FailLoginCount: failLoginCount,
	}

	return Success(c, counter)
}

func (api OverviewApi) OverviewAssetEndPoint(c echo.Context) error {
	var (
		ssh        int64
		rdp        int64
		vnc        int64
		telnet     int64
		kubernetes int64
	)

	ssh, _ = repository.AssetRepository.CountByProtocol(context.TODO(), nt.SSH)
	rdp, _ = repository.AssetRepository.CountByProtocol(context.TODO(), nt.RDP)
	vnc, _ = repository.AssetRepository.CountByProtocol(context.TODO(), nt.VNC)
	telnet, _ = repository.AssetRepository.CountByProtocol(context.TODO(), nt.Telnet)
	kubernetes, _ = repository.AssetRepository.CountByProtocol(context.TODO(), nt.K8s)

	m := echo.Map{
		"ssh":        ssh,
		"rdp":        rdp,
		"vnc":        vnc,
		"telnet":     telnet,
		"kubernetes": kubernetes,
		"all":        ssh + rdp + vnc + telnet + kubernetes,
	}
	return Success(c, m)
}

func (api OverviewApi) OverviewDateCounterEndPoint(c echo.Context) error {
	d := c.QueryParam("d")
	var days = 7
	if d == "month" {
		days = 30
	}
	now := time.Now()
	lastDate := now.AddDate(0, 0, -days)
	// 最近一月登录次数
	loginLogCounters, err := repository.LoginLogRepository.CountWithGroupByLoginTime(context.TODO(), lastDate)
	if err != nil {
		return err
	}
	// 最近一月活跃用户
	userCounters, err := repository.LoginLogRepository.CountWithGroupByLoginTimeAndUsername(context.TODO(), lastDate)
	if err != nil {
		return err
	}
	// 最近一月活跃资产
	sessionCounters, err := repository.SessionRepository.CountWithGroupByLoginTime(context.TODO(), lastDate)
	if err != nil {
		return err
	}

	var counters []dto.DateCounter
	for i := 0; i < days; i++ {
		day := lastDate.AddDate(0, 0, i).Format("2006-01-02")

		var exist = false
		for _, counter := range loginLogCounters {
			if counter.Date == day {
				exist = true
				counters = append(counters, dto.DateCounter{
					Type:  "登录次数",
					Date:  day,
					Value: counter.Value,
				})
				break
			}
		}

		if !exist {
			counters = append(counters, dto.DateCounter{
				Type:  "登录次数",
				Date:  day,
				Value: 0,
			})
		}

		exist = false
		for _, counter := range userCounters {
			if counter.Date == day {
				exist = true
				counters = append(counters, dto.DateCounter{
					Type:  "活跃用户",
					Date:  day,
					Value: counter.Value,
				})
				break
			}
		}

		if !exist {
			counters = append(counters, dto.DateCounter{
				Type:  "活跃用户",
				Date:  day,
				Value: 0,
			})
		}

		exist = false
		for _, counter := range sessionCounters {
			if counter.Date == day {
				exist = true
				counters = append(counters, dto.DateCounter{
					Type:  "活跃资产",
					Date:  day,
					Value: counter.Value,
				})
				break
			}
		}

		if !exist {
			counters = append(counters, dto.DateCounter{
				Type:  "活跃资产",
				Date:  day,
				Value: 0,
			})
		}
	}

	return Success(c, counters)
}

func (api OverviewApi) OverviewPS(c echo.Context) error {
	return Success(c, stat.SystemLoad)
}
