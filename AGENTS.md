# Repository Guidelines

> 开源交互审计系统（堡垒机/跳板机），支持 RDP/SSH/VNC/Telnet/Kubernetes 协议。
> Go 后端 + React (Ant Design) 前端，通过 Guacamole 协议或原生 SSH WebSocket 连接目标资产。
> Fork 自 dushixiang/next-terminal v1.3.9，AGPL-3.0 协议，当前 v1.4.x。

## Architecture & Data Flow

### 三层调用链

```
API (server/api/) → Service (server/service/) → Repository (server/repository/) → GORM (SQLite/MySQL)
```

- **API 层**：Echo v4 路由处理器，每个资源对应一个 `XxxApi struct{}`，方法签名 `func (api XxxApi) EndpointName(c echo.Context) error`。直接调用 Service 层全局单例。
- **Service 层**：业务逻辑，每个服务是全局单例变量（`var XxxService = new(xxxService)`），嵌入 `baseService`。事务通过 `service.Transaction(ctx, func)` 管理，事务 DB 通过 `context.Context` 传递。
- **Repository 层**：数据访问，每个仓库是全局单例变量（`var XxxRepository = new(xxxRepository)`），嵌入 `baseRepository`。通过 `r.GetDB(c)` 从 context 取事务 DB 或回退全局 DB。

### 依赖注入方式

**全局单例**，非 DI 容器。所有 Service/Repository 在包级 `var` 初始化，通过 `context.Context` 携带事务 DB。关键全局单例：

| 单例 | 文件 | 职责 |
|------|------|------|
| `config.GlobalCfg` | `server/config/config.go` | Viper 配置 |
| `env.GetDB()` | `server/env/env.go` | GORM DB 实例 |
| `session.GlobalSessionManager` | `server/global/session/session.go` | WebSocket 会话管理 |
| `cache.TokenManager` | `server/global/cache/cache.go` | JWT Token 内存缓存 |
| `cache.PermissionCache` | 同上 | 权限缓存（5min TTL） |
| `gateway.GatewayService` | `server/global/gateway/` | SSH 隧道接入网关 |
| `security.GlobalSecurity` | `server/global/security/` | IP 黑白名单 |
| `sshd.Sshd` | `server/sshd/sshd.go` | 内嵌 SSH 服务器 |

### 会话连接模式

两种模式由 `model.Session.Mode` 字段控制：

1. **Guacamole 模式** (`nt.Guacd`)：浏览器 WS → 后端 → guacd → 目标资产。支持 RDP/VNC/Telnet/K8s/SSH。录屏由 guacd 生成。Handler: `server/api/guacamole.go`。
2. **原生 SSH 模式** (`nt.Native`)：浏览器 WS → 后端 `server/common/term/ssh.go` → 目标资产。纯 Go SSH 客户端，asciinema cast 录屏。Handler: `server/api/term.go`。

### 启动流程

`main.go` → `app.Run()`：
1. `app.InitDBData()` — 加载网关、初始化属性/用户/定时任务、修复状态、加密凭据、初始化菜单/角色、执行数据迁移
2. `app.ReloadData()` — 重载安全策略、Token、AccessToken
3. `setupRoutes()` — 注册全部路由 + 中间件链
4. 启动定时任务 `task.Ticker`
5. 可选启动内嵌 SSH 服务器 `sshd.Sshd.Serve()`
6. `setupIPExtractor()` — 配置可信代理 IP 提取策略
7. 设置 HTTP 超时参数，启动 Echo HTTP 服务器

### 中间件链

```
Recover → CORS → ErrorHandler → TcpWall (IP 黑白名单) → Auth (Token + RBAC) → Gzip
```

## Key Directories

| 目录 | 职责 |
|------|------|
| `server/api/` | Echo 路由处理器，HTTP 端点 |
| `server/api/worker/` | Worker 节点专用 API（分布式子节点调用） |
| `server/service/` | 业务逻辑层 |
| `server/repository/` | GORM 数据访问层 |
| `server/model/` | GORM 数据模型（对应数据库表） |
| `server/dto/` | 请求/响应传输对象、消息格式 |
| `server/app/` | 应用启动、路由注册、中间件 |
| `server/app/middleware/` | auth、error_handler、tcpwall 中间件 |
| `server/config/` | Viper 配置解析 |
| `server/branding/` | 品牌定制（版本号、名称、Banner） |
| `server/log/` | 自定义日志库 |
| `server/utils/` | 通用工具（keyed_mutex、password、command） |
| `server/global/` | 全局单例：cache、session、gateway、security、stat、cron |
| `server/common/` | Guacamole 协议、SSH/Terminal 客户端、TOTP、工具集合 |
| `server/common/term/` | 原生 SSH 终端（next_terminal.go、ssh.go、recorder.go、tmux.go） |
| `server/common/guacamole/` | Guacamole 协议实现（guacd 隧道、指令解析） |
| `server/sshd/` | 内嵌 SSH 服务器（gliderlabs/ssh），TUI 菜单入口 |
| `server/task/` | 定时任务（系统负载采集、过期清理） |
| `server/env/` | 数据库初始化、AutoMigrate、索引迁移 |
| `server/resource/` | `go:embed` 嵌入的前端静态资源 |
| `web/src/` | React 前端源码 |
| `web/src/api/` | 前端 API 调用层（每资源一个 class extends Api） |
| `web/src/common/` | 前端通用：request.js (axios)、env.js、auth.js、constants.js |
| `web/src/components/` | React 组件（按功能域分组：access、session、asset、dashboard 等） |
| `web/src/layout/` | 布局组件、路由配置 |

## Development Commands

```bash
# 完整构建（前端 + Go + upx 压缩）
sh build.sh

# 仅 Go 后端
go mod tidy
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags '-s -w' -o next-terminal main.go

# 前端构建
cd web && yarn build

# 前端开发模式（代理到 localhost:8088）
cd web && yarn start

# Go lint
golangci-lint run --timeout=5m ./...

# Go 测试（仅 2 个测试文件）
go test ./server/api/... ./server/service/...

# 前端测试
cd web && yarn test
```

## Code Conventions & Common Patterns

### 后端 Go

**全局单例 + context 传事务 DB**：
```go
// repository 嵌入 baseRepository，从 context 取事务 DB
var SessionRepository = new(sessionRepository)
type sessionRepository struct{ baseRepository }
func (r sessionRepository) FindById(c context.Context, id string) (o model.Session, err error) {
    return r.GetDB(c).Where("id = ?", id).First(&o).Error
}

// service 嵌入 baseService，开事务后通过 context 传递
var SessionService = new(sessionService)
type sessionService struct{ baseService }
func (s sessionService) DeleteByIds(c context.Context, ids []string) error {
    return s.Transaction(c, func(ctx context.Context) error {
        return repository.SessionRepository.DeleteByIds(ctx, ids)
    })
}
```

**API 响应格式**：所有响应 HTTP 200，业务状态在 body 的 `code` 字段：
```go
api.Success(c, data)    // { "code": 1, "message": "success", "data": ... }
api.Fail(c, 401, "msg") // { "code": 401, "message": "msg" }
```

**GORM 模型约定**：
- 手动 `TableName()` 方法，表名复数（`sessions`、`users`、`assets`）
- 主键 `string` 类型 `varchar(36)`（UUID）
- 时间字段用 `common.JsonTime`（自定义 JSON 时间格式）
- GORM tag 中 `index` 与其他属性**必须用分号分隔**（`gorm:"index;type:varchar(36)"`），逗号分隔会导致索引被静默丢弃（GORM bug，见 `env/db.go` 注释）
- 新增索引不依赖 model tag，统一在 `env/db.go:migrateIndexes()` 用 `CREATE INDEX IF NOT EXISTS` 补齐

**分页查询**：必须 `Offset(x).Limit(y).Find(&o)` 顺序调用（`Find` 是 GORM finisher，放在前面会使 Offset/Limit 失效）。

**并发模式**：
- WebSocket 写操作统一收敛到 `Session.WriteMessage/WriteString/WriteMessageBytes`（内置 `sync.Mutex` + 10s WriteDeadline）
- Guacd 隧道 `Tunnel.WriteAndFlush` 内置 `sync.Mutex`
- SFTP 客户端懒初始化用 `sync.Mutex` 保护
- 观察者异步队列（buffered channel cap 256），慢观察者不阻塞主会话

**错误处理**：直接返回 `error`，API 层用 `api.Fail` 包装。`panic` 仅用于启动阶段（DB 连接失败）。每个 goroutine 首行 `defer recover()` 防止 panic 击穿进程。

**GORM tag 注意**：`gorm:"index,type:varchar(36)"` 写法中逗号会导致 GORM tag 解析器将整段视为一个 key，`INDEX` 设置为空，索引被丢弃。正确写法为 `gorm:"index;type:varchar(36)"`（分号分隔）。存量 model 普遍用了逗号写法，索引在 `migrateIndexes()` 手动补齐。

### 前端 React

**API 层模式**：每资源一个 class 继承 `Api` 基类：
```js
// web/src/api/api.js — 基类提供 getById/getPaging/getAll/create/updateById/deleteById
class SessionApi extends Api {
    constructor() { super("sessions"); }
    // 自定义端点...
}
const sessionApi = new SessionApi();
export default sessionApi;
```

**HTTP 客户端**：`web/src/common/request.js` — axios 封装，60s 超时，Token 通过 `X-Auth-Token` header 传递（`getHeaders()` 从 sessionStorage 取）。错误处理统一弹 antd `message`，业务失败也 resolve（不 reject），调用方以 `result.code === 1` 判断。

**路由**：`React.lazy` + `Suspense` 懒加载所有页面组件。路由配置在 `web/src/layout/router.js`。权限控制通过 `sessionStorage` 中的 `permissions` 数组（`HasPermission`）和 `user.menus`（`hasMenu`）。

**认证状态**：用户信息存 `localStorage`（`setCurrentUser/getCurrentUser`），权限列表存 `sessionStorage`。无 Redux，用 react-query 管理服务端状态。

**WebSocket**：终端连接通过 `wsServer` 环境变量（`ws://` 或 `wss://`）建立。断线重连由前端发起，重连令牌通过 HMAC 校验。

**环境配置**：`web/src/common/env.js` 根据 `REACT_APP_ENV` 区分开发/生产，生产环境 WS 地址从 `window.location` 派生。

**构建**：CRA + `react-app-rewired`（`config-overrides.js`）。`@ant-design/pro-components` 样式异步 import 避免阻塞首屏。

## Important Files

| 文件 | 作用 |
|------|------|
| `main.go` | 入口，调用 `app.Run()` |
| `server/app/app.go` | `Run()` 启动流程、`InitDBData()` 数据初始化、`setupIPExtractor` |
| `server/app/server.go` | `setupRoutes()` 全部路由注册、静态资源服务、中间件链 |
| `server/app/cache.go` | Token 缓存 eviction 回调绑定 |
| `server/api/api.go` | `Success/Fail/GetToken/GetCurrentAccount` 公共方法 |
| `server/api/session.go` | 会话 CRUD、文件系统操作、预览端点 |
| `server/api/term.go` | 原生 SSH WebSocket handler |
| `server/api/guacamole.go` | Guacamole WebSocket handler |
| `server/api/term_handler.go` | SSH 输出泵、flush 逻辑、观察者扇出 |
| `server/app/middleware/auth.go` | Token 认证、RBAC 权限校验、Admin 中间件 |
| `server/global/session/session.go` | WebSocket 会话管理、断线重连、观察者异步队列 |
| `server/common/term/next_terminal.go` | SSH 终端客户端封装 |
| `server/common/guacamole/guacd.go` | Guacamole 协议指令解析、guacd 隧道 |
| `server/config/config.go` | Viper 配置解析、Config 结构体 |
| `server/env/db.go` | DB 初始化、AutoMigrate、索引迁移 |
| `server/env/env.go` | 全局 DB 单例 |
| `server/branding/branding.go` | 版本号、名称、Banner（修改版本号在这里） |
| `server/resource/resource.go` | `go:embed *` 嵌入前端 |
| `config.yml` | 运行时配置 |
| `config.yml.example` | 配置模板（含注释说明） |
| `build.sh` | 完整构建脚本 |
| `Dockerfile` | 多阶段 Docker 构建 |
| `web/src/common/request.js` | axios HTTP 客户端封装 |
| `web/src/common/env.js` | 环境/服务器地址配置 |
| `web/src/api/api.js` | 前端 API 基类 |
| `web/src/App.js` | React 应用入口、懒加载路由 |

## Runtime/Tooling Preferences

- **Go**: 1.20+（CI 用 1.22）
- **Node**: 18+，包管理器 **yarn**（非 npm）
- **前端框架**: CRA (react-scripts 5) + react-app-rewired，非 Vite
- **DB**: SQLite（默认，`glebarez/sqlite` 纯 Go 驱动）或 MySQL
- **Go lint**: golangci-lint，启用的 linter：`errcheck, gofmt, goimports, govet, ineffassign, typecheck`。`goimports` 本地前缀 `next-terminal`
- **Go 产物**: `CGO_ENABLED=0` + `-ldflags '-s -w'` + UPX 压缩
- **Docker**: Alpine 基础镜像，多阶段构建，单二进制交付
- **时区**: Asia/Shanghai（Docker 镜像内配置）

## Testing & QA

### Go 测试

测试极少，仅 2 个文件：

| 文件 | 测试内容 |
|------|---------|
| `server/api/term_handler_test.go` | 观察者异步队列不阻塞主会话输出（回归测试） |
| `server/service/storage_test.go` | 存储服务 |

运行：`go test ./server/api/... ./server/service/...`

### 前端测试

仅 `web/src/App.test.js`（CRA 默认生成）。框架：Jest（react-scripts 内置）。

运行：`cd web && yarn test`

### CI

| 工作流 | 触发 | 内容 |
|--------|------|------|
| `golangci-lint.yml` | push to master/be-*/dev, PR | golangci-lint 检查 |
| `release-next-terminal.yml` | tag `v*`, manual | 完整构建 + GitHub Release（tar.gz） |

### 验证约定

项目无自动化测试套件覆盖业务逻辑。改动后验证方式：`go build` 编译通过 + 手动功能验证。涉及 `guacamole.go`/`term_handler.go`/`next_terminal.go` 等核心数据路径的改动，必须本地搭建 RDP/SSH 环境验证。

## 非显而易见的关键约定

1. **RDP 保活**：唯一安全方式是 Go 后端每 15s 向 guacd 发 `3.nop;` 指令。禁用 WebSocket ping、Guacamole sync、ReadDeadline（均有回滚历史，详见 `.claude/CLAUDE.md`）。

2. **SSH stdin 不缓冲**：`NextTerminal.Write()` 直接写 `StdinPipe`，严禁包裹 `bufio.Writer`（交互式输入每键 1 字节，缓冲后永远填不满）。

3. **GORM 分页顺序**：`Offset(x).Limit(y).Find(&o)` — `Find` 是 finisher，必须在最后。`Find(&o).Offset(x).Limit(y)` 会使分页失效（全表返回）。

4. **GORM index tag 逗号 bug**：`gorm:"index,type:varchar(36)"` 中逗号使索引被丢弃。新增索引一律在 `env/db.go:migrateIndexes()` 手动添加。

5. **断线重连**：`Session.TryReattach`（锁内换绑 ws），严禁新建 handler 绑定既有隧道——SSH stdout 和 guacd 隧道都是单读者。

6. **文件下载**：必须先发 HTTP 响应头再流式读取文件（`io.Copy`），禁止全量缓冲到内存。

7. **RDP resize-method**：必须用 `reconnect`（1-2s 黑屏），不能用 `display-update`（部分 Windows 环境导致 guacd 直接断开）。

8. **录屏路径安全**：`NewRecorder` 对父目录执行 `os.RemoveAll`，录屏路径必须位于 sessionId 专用子目录。`service.safeRecordingPath` 防御 sessionId 含 `..` 的路径穿越。

9. **sourcemap 剔除**：构建脚本和 Dockerfile 都会 `find ... -name '*.map' -delete`，防止前端源码通过 `/static/*` 匿名泄露。

10. **权限缓存**：`cache.PermissionCache` TTL 5 分钟，权限变更后最多 5 分钟生效。需即时生效则 `cache.PermissionCache.Delete(userId)`。

11. **IP 提取**：Echo 默认无条件采信 `X-Forwarded-For`。`setupIPExtractor` 根据是否配置 `trusted-proxies` 选择策略——直连部署用 `ExtractIPDirect`（忽略 XFF），反代部署仅信任配置的代理网段。

12. **SQLite 并发**：WAL 模式 + `busy_timeout(5000)` + `MaxOpenConns(1)`，避免 `SQLITE_BUSY`。

13. **Session 文件端点权限**：会话文件操作端点（ls/download/upload/edit/rm/rename）从 RBAC 菜单权限中放行，靠 handler 内 `checkSessionOwner` 做归属判定——这是唯一权限防线。
