package app

import (
	"encoding/json"
	"fmt"
	"net"
	"time"

	"next-terminal/server/branding"
	"next-terminal/server/config"
	"next-terminal/server/log"
	"next-terminal/server/service"
	"next-terminal/server/sshd"
	"next-terminal/server/task"

	"github.com/labstack/echo/v4"
)

var app *App

type App struct {
	Server *echo.Echo
}

func newApp() *App {
	return &App{}
}

func init() {
	setupCache()
	app = newApp()
}

func (app App) InitDBData() (err error) {
	if err := service.PropertyService.DeleteDeprecatedProperty(); err != nil {
		return err
	}
	if err := service.GatewayService.LoadAll(); err != nil {
		return err
	}
	if err := service.PropertyService.InitProperties(); err != nil {
		return err
	}
	if err := service.UserService.InitUser(); err != nil {
		return err
	}
	if err := service.JobService.InitJob(); err != nil {
		return err
	}
	if err := service.UserService.FixUserOnlineState(); err != nil {
		return err
	}
	if err := service.SessionService.FixSessionState(); err != nil {
		return err
	}
	if err := service.SessionService.EmptyPassword(); err != nil {
		return err
	}
	if err := service.CredentialService.EncryptAll(); err != nil {
		return err
	}
	if err := service.AssetService.EncryptAll(); err != nil {
		return err
	}
	if err := service.StorageService.InitStorages(); err != nil {
		return err
	}
	if err := service.MenuService.Init(); err != nil {
		return err
	}
	if err := service.RoleService.Init(); err != nil {
		return err
	}
	// 修复数据
	if err := service.AssetService.FixSshMode(); err != nil {
		return err
	}
	if err := service.SessionService.FixSshMode(); err != nil {
		return err
	}

	if err := service.MigrateService.Migrate(); err != nil {
		return err
	}

	return nil
}

func (app App) ReloadData() error {
	if err := service.SecurityService.ReloadAccessSecurity(); err != nil {
		return err
	}
	if err := service.UserService.ReloadToken(); err != nil {
		return err
	}
	if err := service.AccessTokenService.Reload(); err != nil {
		return err
	}
	return nil
}

func Run() error {

	fmt.Printf(branding.Hi)

	if err := app.InitDBData(); err != nil {
		panic(err)
	}
	if err := app.ReloadData(); err != nil {
		panic(err)
	}
	app.Server = setupRoutes()

	if config.GlobalCfg.Debug {
		jsonBytes, err := json.MarshalIndent(config.GlobalCfg, "", "    ")
		if err != nil {
			return err
		}
		fmt.Printf("当前配置为: %v\n", string(jsonBytes))
	}

	_cli := service.NewCli()

	if config.GlobalCfg.ResetPassword != "" {
		return _cli.ResetPassword(config.GlobalCfg.ResetPassword)
	}
	if config.GlobalCfg.ResetTotp != "" {
		return _cli.ResetTotp(config.GlobalCfg.ResetTotp)
	}

	if config.GlobalCfg.NewEncryptionKey != "" {
		return _cli.ChangeEncryptionKey(config.GlobalCfg.EncryptionKey, config.GlobalCfg.NewEncryptionKey)
	}

	ticker := task.NewTicker()
	ticker.SetupTicker()

	if config.GlobalCfg.Sshd.Enable {
		go sshd.Sshd.Serve()
	}

	// 客户端 IP 提取策略。
	//
	// Echo 在未设置 IPExtractor 时会无条件采信 X-Forwarded-For / X-Real-IP 请求头，
	// 而该值同时用于安全策略 IP 黑白名单（TcpWall）、登录失败锁定键、以及审计日志的
	// 客户端 IP——任何人都能通过伪造请求头同时绕过三者。
	//
	// 因此这里必须显式选择：反代部署只信任配置的代理网段，直连部署完全忽略 XFF。
	setupIPExtractor(app.Server)

	// HTTP 超时防护：慢速请求兜底。WS 端点升级后 hijack，不受影响；
	// 不设 WriteTimeout——文件下载为流式长响应，会被误杀
	app.Server.Server.ReadHeaderTimeout = 10 * time.Second
	// ReadTimeout 的语义是「读完整个请求（含 body）」，会截断长时间上传：
	// 30s 下按 10Mbps 上行折算约 37MB 即被切断。大文件上传（会话文件管理、
	// 云盘上传、资产 CSV 导入、备份恢复）会踩到该隐性上限，故放宽到 10 分钟，
	// 慢速攻击仍由上面的 ReadHeaderTimeout 与各端点的体积限制兜底。
	app.Server.Server.ReadTimeout = 10 * time.Minute
	app.Server.Server.IdleTimeout = 120 * time.Second
	app.Server.Server.MaxHeaderBytes = 1 << 20

	if config.GlobalCfg.Server.Cert != "" && config.GlobalCfg.Server.Key != "" {
		return app.Server.StartTLS(config.GlobalCfg.Server.Addr, config.GlobalCfg.Server.Cert, config.GlobalCfg.Server.Key)
	} else {
		return app.Server.Start(config.GlobalCfg.Server.Addr)
	}
}

// setupIPExtractor 决定 c.RealIP() 的取值来源。
//
// 背景：Echo 未设置 IPExtractor 时会无条件采信 X-Forwarded-For / X-Real-IP 请求头。
// 该值同时用于三处安全控制——安全策略的 IP 黑白名单（TcpWall）、登录失败锁定计数键、
// 以及登录日志/会话记录的客户端 IP。不显式配置等于三者全部可被请求头伪造绕过。
//
//   - 未配置 trusted-proxies（直连部署）：ExtractIPDirect 忽略一切转发头，
//     客户端 IP 取自 TCP 对端地址，不可伪造。
//   - 配置了 trusted-proxies（反代部署）：仅当直连来源落在可信网段内时才采信 XFF。
//     这样即使服务端口被绕过反代直接访问，伪造的 XFF 同样不生效。
func setupIPExtractor(e *echo.Echo) {
	cidrs := config.GlobalCfg.Server.TrustedProxies
	if len(cidrs) == 0 {
		e.IPExtractor = echo.ExtractIPDirect()
		log.Info("客户端 IP 提取策略：直连模式（忽略 X-Forwarded-For）。" +
			"若部署在反向代理之后，请配置 server.trusted-proxies，否则安全策略的 IP 黑白名单将失效")
		return
	}

	trustOptions := make([]echo.TrustOption, 0, len(cidrs))
	for _, cidr := range cidrs {
		_, ipNet, err := net.ParseCIDR(cidr)
		if err != nil {
			log.Warn("server.trusted-proxies 中存在非法 CIDR，已忽略该项",
				log.String("value", cidr), log.NamedError("err", err))
			continue
		}
		trustOptions = append(trustOptions, echo.TrustIPRange(ipNet))
	}

	if len(trustOptions) == 0 {
		e.IPExtractor = echo.ExtractIPDirect()
		log.Warn("server.trusted-proxies 无有效 CIDR，已降级为直连模式")
		return
	}

	e.IPExtractor = echo.ExtractIPFromXFFHeader(trustOptions...)
	log.Info("客户端 IP 提取策略：反向代理模式",
		log.Int("trustedRanges", len(trustOptions)))
}
