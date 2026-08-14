package api

import (
	"context"
	"next-terminal/server/common/nt"
	"next-terminal/server/dto"
	"next-terminal/server/global/stat"
	"next-terminal/server/repository"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
)

type OverviewApi struct{}

// overview 统计缓存：首页计数/图表为串行 COUNT + 全表聚合，前端本就轮询展示，
// 短 TTL 缓存消除重复重查询（数据延迟 ≤ TTL，用户无感知）
var overviewCache = struct {
	sync.Mutex
	m map[string]overviewCached
}{m: map[string]overviewCached{}}

type overviewCached struct {
	expires time.Time
	data    interface{}
}

func cachedOverview(key string, ttl time.Duration, f func() (interface{}, error)) (interface{}, error) {
	now := time.Now()
	overviewCache.Lock()
	if v, ok := overviewCache.m[key]; ok && v.expires.After(now) {
		overviewCache.Unlock()
		return v.data, nil
	}
	overviewCache.Unlock()

	data, err := f()
	if err != nil {
		return nil, err
	}
	overviewCache.Lock()
	overviewCache.m[key] = overviewCached{expires: now.Add(ttl), data: data}
	overviewCache.Unlock()
	return data, nil
}

func (api OverviewApi) OverviewCounterEndPoint(c echo.Context) error {
	data, err := cachedOverview("counter", 30*time.Second, func() (interface{}, error) {
		totalUser, _ := repository.UserRepository.Count(context.TODO())
		onlineUser, _ := repository.UserRepository.CountOnlineUser(context.TODO())
		countOfflineSession, _ := repository.SessionRepository.CountOfflineSession(context.TODO())
		totalAsset, _ := repository.AssetRepository.Count(context.TODO())
		activeAsset, _ := repository.AssetRepository.CountByActive(context.TODO(), true)
		failLoginCount, _ := repository.LoginLogRepository.CountByState(context.TODO(), "0")

		return dto.Counter{
			TotalUser:      totalUser,
			OnlineUser:     onlineUser,
			OfflineSession: countOfflineSession,
			TotalAsset:     totalAsset,
			ActiveAsset:    activeAsset,
			FailLoginCount: failLoginCount,
		}, nil
	})
	if err != nil {
		return err
	}
	return Success(c, data)
}

func (api OverviewApi) OverviewAssetEndPoint(c echo.Context) error {
	data, err := cachedOverview("asset", 30*time.Second, func() (interface{}, error) {
		ssh, _ := repository.AssetRepository.CountByProtocol(context.TODO(), nt.SSH)
		rdp, _ := repository.AssetRepository.CountByProtocol(context.TODO(), nt.RDP)
		vnc, _ := repository.AssetRepository.CountByProtocol(context.TODO(), nt.VNC)
		telnet, _ := repository.AssetRepository.CountByProtocol(context.TODO(), nt.Telnet)
		kubernetes, _ := repository.AssetRepository.CountByProtocol(context.TODO(), nt.K8s)

		return echo.Map{
			"ssh":        ssh,
			"rdp":        rdp,
			"vnc":        vnc,
			"telnet":     telnet,
			"kubernetes": kubernetes,
			"all":        ssh + rdp + vnc + telnet + kubernetes,
		}, nil
	})
	if err != nil {
		return err
	}
	return Success(c, data)
}

func (api OverviewApi) OverviewDateCounterEndPoint(c echo.Context) error {
	d := c.QueryParam("d")
	var days = 7
	if d == "month" {
		days = 30
	}
	cacheKey := "dateCounter-" + d

	data, err := cachedOverview(cacheKey, 60*time.Second, func() (interface{}, error) {
		return loadDateCounters(days)
	})
	if err != nil {
		return err
	}
	return Success(c, data)
}

func loadDateCounters(days int) (interface{}, error) {
	now := time.Now()
	lastDate := now.AddDate(0, 0, -days)
	// 最近一月登录次数
	loginLogCounters, err := repository.LoginLogRepository.CountWithGroupByLoginTime(context.TODO(), lastDate)
	if err != nil {
		return nil, err
	}
	// 最近一月活跃用户
	userCounters, err := repository.LoginLogRepository.CountWithGroupByLoginTimeAndUsername(context.TODO(), lastDate)
	if err != nil {
		return nil, err
	}
	// 最近一月活跃资产
	sessionCounters, err := repository.SessionRepository.CountWithGroupByLoginTime(context.TODO(), lastDate)
	if err != nil {
		return nil, err
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

	return counters, nil
}

func (api OverviewApi) OverviewPS(c echo.Context) error {
	// 读锁保护：ticker 每 5s 就地更新 SystemLoad，与 marshal 并发为数据竞争
	stat.SystemLoadMutex.RLock()
	defer stat.SystemLoadMutex.RUnlock()
	return Success(c, stat.SystemLoad)
}
