# Next Terminal v1.5.0

[![Docker next-terminal build](https://github.com/xyzbeta/next-terminal/actions/workflows/release-next-terminal.yml/badge.svg)](https://github.com/xyzbeta/next-terminal/actions/workflows/release-next-terminal.yml)

> 开源交互审计系统 — 堡垒机/跳板机，支持 RDP、SSH、VNC、Telnet、Kubernetes 协议。
> 本项目基于 [dushixiang/next-terminal](https://github.com/dushixiang/next-terminal) v1.3.9 二次开发优化。

---

## 版权声明

本项目 Fork 自 [dushixiang/next-terminal](https://github.com/dushixiang/next-terminal) v1.3.9 版本。

```
Copyright © 2020-2026 dushixiang, All Rights Reserved.
```

原始项目使用 [AGPL-3.0](./LICENSE) 开源协议，本项目继承相同协议。感谢原作者 [dushixiang](https://github.com/dushixiang) 的优秀工作。

---

## 快速了解

Next Terminal 是一个简单好用安全的开源交互审计系统，支持 RDP、SSH、VNC、Telnet、Kubernetes 协议。

### v1.3.9 原有功能

- 授权凭证管理
- 资产管理（支持 RDP、SSH、VNC、TELNET 协议）
- 指令管理
- 批量执行命令
- 在线会话管理（监控、强制断开）
- 离线会话管理（查看录屏）
- 双因素认证（TOTP）
- 资产标签
- 资产授权
- 多用户 & 用户分组
- 计划任务
- 内嵌 SSH Server（TUI 菜单选择资产连接）
- 登录策略
- 接入网关（SSH 隧道代理内网资产）
- 系统监控

### 关于版本号

v1.5.0 涵盖了从 v1.3.9 到 v1.5.0 的全部变更。中间的 v1.4.0～v1.4.4 以及后续数十轮迭代修复，统一归入 v1.5.0 发布。下文按功能域分类列出所有新增功能、优化和修复。

---

## 一、新增功能

### 1. 移动端全面适配

原版 v1.3.9 仅有桌面端布局，移动端体验严重不足。v1.5.0 实现了完整的移动端响应式适配。

| 功能 | 说明 |
|------|------|
| 响应式布局 | 768px 断点检测，移动端自动切换卡片列表布局 |
| 底部导航栏 | 移动端底部 Tab 导航（概览/会话/资产/更多），替代桌面侧边栏 |
| 卡片列表组件 | `MobileList` 统一组件：分页、搜索、筛选、触底加载，所有列表页复用 |
| 悬浮操作菜单 | 终端页可折叠浮动菜单（断开/文件/命令/按键/字号/跳底） |
| TUI 按键条 | 软键盘没有方向键/Esc，按键条提供 TUI 必需的控制键。两层结构（6 常驻 + 16 低频键） |
| 触摸滚动 | tmux/alt-screen/mouse-tracking 三条件检测 SGR 滚轮发送，手指滑动即可翻阅终端历史 |
| 软键盘适配 | `100dvh` 动态视口 + `visualViewport` 监听 + IME 组合输入防抖 |
| 系统设置适配 | 移动端用 Select 下拉导航替代横向 Tab 页签，左右箭头顺序切换 |
| 仪表盘拆分 | Desktop/Mobile 独立组件，移动端零图表依赖（17KB vs 872KB） |

### 2. 暗黑模式

原版 v1.3.9 仅有浅色主题。v1.5.0 实现完整暗黑模式支持。

| 功能 | 说明 |
|------|------|
| 三种模式 | 跟随系统（auto）、浅色（light）、深色（dark），系统设置中切换 |
| CSS 变量体系 | `:root` / `:root[data-theme]` / `@media(prefers-color-scheme)` 三层覆盖 |
| 全组件覆盖 | antd 全组件 `!important` 覆盖：表格、卡片、模态框、抽屉、输入框、菜单、分页等 |
| 消息弹窗 | `.ant-message-notice-content` 暗色背景，外层透明不占行 |
| 侧边导航 | 浅色保持 `#001529`，暗色 `var(--bg-card)`，Drawer 特异性隔离 |
| 终端面板 | 字体面板/按键条固定暗色（浮在暗色终端上），`!important` 防浅色覆盖 |
| 内联样式迁移 | `Landing`/`MyInfo`/`Term`/`Asset` 等组件内联白色改 CSS 变量/class |

### 3. tmux 会话保持

原版 v1.3.9 断开 SSH 即终止远端任务。v1.5.0 引入 tmux 实现会话保持。

| 功能 | 说明 |
|------|------|
| tmux 会话管理 | 创建/attach/kill/状态检测，`message-bg default` 抑制黄色指示器 |
| 会话保持参数 | 移动端默认开启 `keep=1`，资产属性可强制覆盖 |
| 在线列表扩展 | 断开的 keep-alive 会话仍显示在在线列表，支持"继续"重连 |
| 手动清理 | `POST /sessions/:id/cleanup` — SSH 上去 kill tmux + 删除记录 |
| TTL 自动清理 | 默认 24h，10 分钟轮询，kill 成功后置 `keep_alive=0` |
| 会话状态标识 | "保持"（绿色）/ "已断开·可恢复"（琥珀色）/ 无标识 |

### 4. 断线重连

原版 v1.3.9 断线即断开，无法恢复。v1.5.0 实现完整重连机制。

| 功能 | 说明 |
|------|------|
| 60s 宽限期 | WebSocket 断开后底层 SSH 保持 60s，支持 `TryReattach` 无缝恢复 |
| tmux 接管 | 宽限期内无重连令牌时，`keep=1` 触发接管（关旧连接 + 新建 SSH + attach） |
| 前端自动重连 | 5 次指数退避（2s/4s/8s/16s/32s），异常断开自动触发 |
| 重连令牌 | HMAC-SHA256 无状态令牌，三重验证（令牌 + JWT + 归属） |
| 强制重绘 | 重连后 `forceRemoteRedraw` — 抖动式 resize 触发 SIGWINCH 全屏重绘 |
| 三不连原则 | 主动关闭 / 收到 Closed / close code 1000-1001 — 均不重连 |
| RDP 重连 | guacd 隧道重连，挂接原隧道，画面由后续帧自然恢复 |
| 输出泵自愈 | SSH/RDP 输出泵在 ws 写失败后继续运行，重连后自动恢复输出 |

### 5. PWA 支持

原版 v1.3.9 是纯 Web 应用。v1.5.0 支持 PWA 安装到主屏。

| 功能 | 说明 |
|------|------|
| Service Worker | 自定义 `sw.js`，缓存优先策略，离线可用 |
| PWA Manifest | 可安装到主屏，maskable 图标适配 Android/iOS |
| 路由自愈 | `RouteFallback` 组件 — chunk 加载失败 15s 自动恢复 |
| 错误边界 | `ErrorBoundary` 捕获 React 渲染异常 |

### 6. 文件预览与终端增强

原版 v1.3.9 文件管理依赖 Monaco Editor，终端交互功能有限。v1.5.0 大幅增强。

| 功能 | 说明 |
|------|------|
| 文件选择器 | `Ctrl+Shift+F` 或点击闪电按钮打开，支持 Tab 补全、↓↑ 导航、Enter 预览，相对路径由后端 SFTP RealPath 解析 |
| 图片预览 | 远程主机图片直接在终端页内预览，不需要打开文件管理器 |
| PDF 预览 | 在线预览远程主机上的 PDF 文件 |
| HTML 预览 | 在线预览远程主机上的 HTML 文件 |
| Markdown 预览 | 在线渲染 Markdown，支持完整语法 |
| 代码高亮预览 | 代码文本文件语法高亮显示，带行号 |
| 字号调节 | 9 档字号（11-22px），自动重排并同步远端 |
| xterm WebGL | GPU 渲染，上下文丢失自动回退 canvas |
| rAF 节流 | 合并同帧多次 `term.write`，减少 DOM 重绘 |
| 终端存活指示器 | 右下角实时显示链路延迟（● XXms），2s 刷新，8s 无响应标记离线 |
| 终端快捷命令 | 工具栏闪电按钮，点击展开命令菜单，支持点击触发 |
| 文件拖拽上传 | 文件拖入文件管理区即上传至当前目录 |
| 回放增强 | SSH 回放支持暂停/倍速/进度跳转 |

### 7. 资产管理增强

| 功能 | 说明 |
|------|------|
| 资产排序模式 | 工具栏「排序」按钮进入排序模式，整行拖拽调整资产顺序（单步移动语义，服务端事务内完成） |
| 资产排序模式（移动端） | 移动端卡片列表同样支持排序模式 |

### 8. RDP/Guacamole 稳定性

原版 v1.3.9 的 RDP 连接存在空闲断开和 resize 断开问题。v1.5.0 全面修复。

| 功能 | 说明 |
|------|------|
| nop 保活 | 每 15s 发 `3.nop;`，防 guacd 检测用户无响应断开 |
| resize-method | 固定 `reconnect`（不用 `display-update`，兼容所有 Windows） |
| 流式下载 | `io.Copy` 替代全量缓冲，浏览器即时弹保存框 |
| 监控端隔离 | 监控写失败只清理自身，不误杀主会话 |
| guacd TCP_NODELAY | 禁用 Nagle 算法，按键延迟 -40ms |
| WebSocket Buffer | 4096 → 32768，提升 RDP 大帧吞吐 |
| WebSocket 压缩 | permessage-deflate 无损压缩，带宽节省 40-50% |
| WebP 优先 | guacd 优先使用 WebP 编码画面帧，同质量下比 JPEG 小 25-35% |
| JPEG/WebP 质量优化 | 质量参数从默认 90 调整为 80，肉眼无感知，帧大小 -30% |
| guacd 读路径单拷贝 | 消除每帧两次全量拷贝 |
| guacd 僵死自愈 | guacd 写操作 10s 超时 + nop 保活失败自动关闭会话 |

---

## 二、性能优化

原版 v1.3.9 在大数据量下存在性能瓶颈。v1.5.0 进行系统性优化。

| 优化项 | 说明 |
|--------|------|
| SQLite WAL | `journal_mode(WAL)` + `busy_timeout(5000)` + `foreign_keys(1)`，并发写不再 SQLITE_BUSY |
| MySQL 连接池 | MaxOpenConns=25, MaxIdleConns=10 |
| 索引补齐 | 13 个高频索引，`CREATE INDEX IF NOT EXISTS`，启动安全 |
| GORM 分页修复 | 12 个 repository 的 `Offset/Limit` 在 `Find` 后不生效问题修复（原版 bug，分页永不生效、全表加载） |
| 权限缓存 | `PermissionCache` 5 分钟 TTL，避免每请求三层嵌套循环 |
| SSH 输出零拷贝 | `WriteMessageBytes` 两段直写，消除多轮全量拷贝 |
| ws 写路径统一锁 | 所有 ws 写收敛到 `Session.WriteMessage`（锁 + 10s WriteDeadline） |
| 分批删除日志 | 防 SQLite `SQLITE_MAX_VARIABLE_NUMBER` (32766) 上限 |
| 批量 SQL 删除 | 清空 10 万条日志由约 30 万次 SQL 降为 1 次 |
| cron SkipIfStillRunning | 任务执行超一个调度周期不叠加执行 |
| 前端 lazy loading | 38 个路由组件懒加载，Monitoring prefetch |
| pro-components 异步 | 84KB ProTable/ProCard 样式从主包迁出异步加载 |
| 录屏存在性缓存 | 断开会话录屏状态不变，命中缓存跳过磁盘 stat |
| 网关隧道防泄漏 | Accept 10s deadline 防僵尸连接积累 |
| Count 单查询 | 首页统计等 9 处计数由「全列 SELECT + COUNT」双查询收敛为单条 COUNT |
| 首页缓存 | 首页计数/图表加 30-60s 缓存 |
| 文件管理分页 | 目录表格分页（每页 100 条），数千文件不再全量渲染 |
| 录屏缓冲写盘 | 录屏文件改为缓冲写出，慢盘不再阻塞终端输出 |
| TermHandler chunk 读取 | 逐字符读取改为 4KB chunk + 32KB 阈值立即刷新，批量输出延迟 -60ms |
| HTTP 超时防护 | 请求读取/空闲超时（不影响 WebSocket 与流式下载） |
| API 请求超时 | 前端 60s 超时兜底，后端慢时不再无限转圈 |
| 资产状态检测并发限制 | 限制并发连接数，防止大批资产检测时耗尽连接 |

---

## 三、稳定性修复

原版 v1.3.9 存在多个稳定性问题。v1.5.0 逐一修复。

| 修复项 | 说明 |
|--------|------|
| 窗口缩放断线 | 调整浏览器窗口时 WebSocket 被误关闭导致 SSH 会话必断 — 连接生命周期与窗口尺寸解耦 |
| 死观察者卡死 | 监控方网络静默死亡时主会话输出被卡住 — 写超时（10s）后自动剔除观察者 |
| keepalive 判死清理 | 心跳连续失败判定断开后，会话状态/WebSocket/全局条目完整关闭（此前状态长期显示"已连接"但实际已死） |
| Shell 任务死锁 | 批量执行 Shell 任务时无缓冲 channel 死锁导致 HTTP 请求永久挂起 |
| 监控端误杀主会话 | 监控 RDP 会话时监控方异常不再导致被监控主会话被整体关闭 |
| panic 防护 | 所有关键 goroutine 增加 recover 兜底；guacamole 指令解析增加边界检查 |
| SQLite 并发写 | 开启 WAL + busy_timeout(5s) + 单连接池，消除并发写 SQLITE_BUSY |
| 分页失效 | 12 个列表接口 GORM 链式顺序错误导致分页永不生效 — 修复 |
| 端口筛选计数 | 资产列表按端口筛选时 total 计数错误 — 修复 |
| 首页计数归零 | GORM Count 失去表推断导致 9 个计数辅助函数静默失败 — 修复 |
| 监控面板白屏 | Stats 面板 API 失败时合并默认值渲染，不再崩溃 |
| SSH 输出 BinaryMessage | SSH 输出改用 WebSocket BinaryMessage，根除 1002 断开 |
| xterm 实例泄漏 | 终端页/监控页卸载时正确 dispose xterm 实例 |
| RDP 隧道泄漏 | RDP 页面卸载时断开 Guacamole 隧道 |
| 查询缓存 key 冲突 | 编辑弹窗不再闪现错误类型/过期数据 |
| 监控页断线感知 | 网络断开时页面明确提示，不再静默冻结 |
| 轮询重试抑制 | 后端异常时监控页不再产生错误提示风暴 |

---

## 四、安全加固

| 安全项 | 说明 |
|--------|------|
| encryption-key | 资产/凭据加密密钥，MD5 派生 AES 密钥，支持 `--new-encryption-key` 迁移 |
| trusted-proxies | 反代部署时配置可信代理网段，正确解析 X-Forwarded-For |
| Sourcemap 剔除 | Dockerfile 构建时删除 `.map` 文件，防止前端源码通过 `/static/*` 泄露 |
| 凭证清理 | `DisDBSess` 断开时清空 password/privateKey 为 `-` |
| SSH 加密套件 | chacha20-poly1305 优先，兼容无 AES-NI 的 CPU |
| SSH Server Keepalive | 每 30s 发 `keepalive@openssh.com`，检测僵死连接 |
| Guacd 主路径归属校验 | 修复任何登录用户凭会话ID可建隧道的越权面 |
| SSH 监控归属校验 | 非管理员仅可监控本人会话 |
| 会话条目防泄漏 | 同名会话重复添加时先关闭旧条目 |
| 会话统计归属校验 | 非管理员仅可拉取本人会话的远端主机统计 |
| Security Manager 读写锁 | 并发安全保护 |
| PKCS5UnPadding 边界检查 | 空数据和损坏数据防 panic |
| 登录策略优先级 | 多条匹配时改为最高优先级生效 |

---

## 五、代码质量改进

| 改进项 | 说明 |
|--------|------|
| goroutine recover 兜底 | 10+ 处关键 goroutine 加 defer recover + 日志，单点 panic 不击穿进程 |
| Instruction.Parse 边界检查 | 畸形帧返回 error，此前 `lm[1]` 越界 panic |
| 观察者写 deadline | 观察者写失败（10s deadline）立即从 map 移除 |
| 关闭链分段锁 | `CloseSessionById` 临界区只保留内存操作，DB 写在锁外 |
| SSH stdin 不缓冲 | `NextTerminal.Write()` 直接写 pipe，不禁 bufio |
| 死代码清理 | 移除未使用的 `Pbkdf2` 函数及依赖、62 行注释代码、16 处 console.log |
| 去重 | nop 保活提取为公共函数 `startNopKeepalive` |
| 资源句柄修复 | 上传文件句柄 Close、SOCKS5 连接失败路径关闭 TCP、Term 组件 pingInterval 清理 |

---

## 配置项

```yaml
debug: false
db: sqlite
mysql:
  hostname: localhost
  port: 3306
  username: next-terminal
  password: next-terminal
  database: next-terminal
sqlite:
  file: './data/sqlite/next-terminal.db'

# 数据加密密钥（必填，留空回退内置默认密钥）
encryption-key: ''

server:
  addr: 0.0.0.0:8088
  # 反代部署时填代理所在网段
  # trusted-proxies:
  #   - 10.0.0.0/8

guacd:
  hostname: 127.0.0.1
  port: 4822
  # 此路径需要为绝对路径，并且 next-terminal 和 guacd 都能访问到
  recording: '/usr/local/next-terminal/data/recording'
  drive: '/usr/local/next-terminal/data/drive'

sshd:
  enable: true
  addr: 0.0.0.0:2022
  key: ~/.ssh/id_rsa
```

### 系统设置中可配置的属性

| 属性 | 默认值 | 说明 |
|------|--------|------|
| `session-saved-limit` | 360 天 | 离线会话保留时长 |
| `login-log-saved-limit` | 360 天 | 登录日志保留时长 |
| `cron-log-saved-limit` | 360 天 | 计划任务日志保留时长 |
| `storage-log-saved-limit` | 360 天 | 存储日志保留时长 |
| `keep-alive-ttl` | 24 小时 | tmux 会话保持清理时长（-1 永久保留） |
| `enable-recording` | true | 开启录屏 |
| `user-default-storage-size` | 5120 MB | 用户空间默认大小 |
| `appearance` | auto | 外观模式（auto/light/dark） |

---

## 快速安装

### Docker Compose（推荐）

```yaml
version: '3'
services:
  guacd:
    image: guacamole/guacd:1.4.0
    network_mode: host
    restart: always

  next-terminal:
    image: dushixiang/next-terminal:v1.4.51
    network_mode: host
    restart: always
    environment:
      DB: sqlite
      SQLITE_FILE: ./data/sqlite/next-terminal.db
      SERVER_PORT: 8088
      SSHD_PORT: 8089
      ENCRYPTION_KEY: 'your-secret-key'
      TZ: Asia/Shanghai
    volumes:
      - ./data:/usr/local/next-terminal/data
    depends_on:
      - guacd
```

默认账号密码为 admin/admin，首次部署后请立即修改。

### 手动编译

1. 找一台 Linux 机器或 Mac
2. 安装 Go 1.20 或以上版本
3. 安装 Node.js 16+，安装 yarn
4. 进入 `web` 目录执行 `yarn && yarn build`
5. 返回项目根目录，执行 `sh build.sh`

---

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Go 1.20+, Echo (HTTP), GORM (ORM), gorilla/websocket, gliderlabs/ssh |
| 前端 | React 17, Ant Design 4.23, xterm.js 4.19, guacamole-common-js |
| 协议 | Guacamole (RDP/VNC/Telnet/K8s), 原生 Go SSH, tmux |
| 数据库 | SQLite (WAL mode) / MySQL |
| 部署 | Docker, Docker Compose, PWA |
| 终端渲染 | xterm.js + WebGL addon + rAF 节流 |

---

## 已知注意事项

| 事项 | 说明 |
|------|------|
| tmux 版本 | 生产服务器 tmux 1.8 不支持 `@copy-mode-current-format`，通过 `message-bg default` 抑制指示器 |
| Service Worker | 更新前端后需等 SW 自动更新或清除浏览器缓存，否则使用旧版本 |
| 终端背景 | 固定 `#1b1b1b` 暗色，不跟随浅/深色主题（终端始终为暗色） |
| RDP resize | 固定 `reconnect` 模式，不用 `display-update`（部分 Windows 不支持） |
| 加密密钥 | 变更后需用 `--new-encryption-key` 重新加密历史数据 |
| SQLite 写权限 | 确保数据目录对进程有写权限 |

---

## 问题反馈

- [Issues](https://github.com/xyzbeta/next-terminal/issues)

## 安全问题

如果您在使用过程中发现了安全问题，请发送邮件至 helloworld1024@foxmail.com 联系。

---

## License

Next Terminal 使用 [AGPL-3.0](./LICENSE) 开源协议，请自觉遵守。原始项目版权归 [dushixiang](https://github.com/dushixiang) 所有。
