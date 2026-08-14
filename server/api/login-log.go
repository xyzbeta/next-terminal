package api

import (
	"context"
	"next-terminal/server/common/maps"
	"next-terminal/server/global/cache"
	"strconv"
	"strings"

	"next-terminal/server/repository"
	"next-terminal/server/service"

	"github.com/labstack/echo/v4"
)

type LoginLogApi struct{}

func (api LoginLogApi) LoginLogPagingEndpoint(c echo.Context) error {
	pageIndex, _ := strconv.Atoi(c.QueryParam("pageIndex"))
	pageSize, _ := strconv.Atoi(c.QueryParam("pageSize"))
	username := c.QueryParam("username")
	clientIp := c.QueryParam("clientIp")
	state := c.QueryParam("state")

	items, total, err := repository.LoginLogRepository.Find(context.TODO(), pageIndex, pageSize, username, clientIp, state)

	if err != nil {
		return err
	}

	return Success(c, maps.Map{
		"total": total,
		"items": items,
	})
}

func (api LoginLogApi) LoginLogDeleteEndpoint(c echo.Context) error {
	ids := c.Param("id")
	tokens := strings.Split(ids, ",")
	if err := service.UserService.DeleteLoginLogs(tokens); err != nil {
		return err
	}

	return Success(c, nil)
}

func (api LoginLogApi) LoginLogClearEndpoint(c echo.Context) error {
	// 直接批量清空日志（原实现先全量加载所有日志仅为了取 ID，10 万行 ≈ 10 万条记录载入内存）
	if err := repository.LoginLogRepository.DeleteAll(context.TODO()); err != nil {
		return err
	}
	// 清空日志即所有登录会话失效：清空 token 缓存并修正在线状态
	cache.TokenManager.Flush()
	if err := service.UserService.FixUserOnlineState(); err != nil {
		return err
	}
	return Success(c, nil)
}
