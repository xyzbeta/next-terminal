# Next Terminal v1.5.0

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

## v1.5.0 版本概述

本次版本是一次重大功能升级，涵盖移动端全面适配、暗黑模式、tmux 会话保持、断线重连机制、PWA 支持及多项性能优化与稳定性加固。相比 v1.4.x 系列，v1.5.0 新增 31 个文件，修改 135 个文件，净增约 4400 行代码。

---

## 核心功能

### 1. 移动端全面适配

| 功能 | 说明 |
|------|------|
| 响应式布局 | 768px 断点检测，移动端自动切换卡片列表布局 |
| 底部导航栏 | 移动端底部 Tab 导航（概览/会话/资产/更多） |
| 卡片列表组件 | `MobileList` 统一组件：分页、搜索、筛选、触底加载 |
| 悬浮操作菜单 | 终端页可折叠浮动菜单（断开/文件/命令/按键/字号/跳底） |
| TUI 按键条 | 两层结构（6 常驻 + 16 低频键），方向键/Tab/Enter 常驻 |
| 触摸滚动 | tmux/alt-screen/mouse-tracking 三条件 SGR 滚轮 |
| 软键盘适配 | `100dvh` 动态视口 + `visualViewport` 监听 + IME 组合输入防抖 |
| 系统设置适配 | 移动端用 Select 导航替代横向 Tab 页签 |
| 仪表盘拆分 | Desktop/Mobile 独立组件，移动端零图表依赖 |

### 2. 暗黑模式

| 功能 | 说明 |
|------|------|
| 三种模式 | 跟随系统（auto）、浅色（light）、深色（dark） |
| CSS 变量体系 | `:root` / `:root[data-theme]` / `@media(prefers-color-scheme)` 三层覆盖 |
| 全组件覆盖 | antd 全组件 `!important` 覆盖：表格、卡片、模态框、抽屉、输入框、菜单、分页等 |
| 消息弹窗 | `.ant-message-notice-content` 暗色背景，外层透明不占行 |
| 侧边导航 | 浅色保持 `#001529`，暗色 `var(--bg-card)`，Drawer 特异性隔离 |
| 终端面板 | 字体面板/按键条固定暗色（浮在暗色终端上），`!important` 防浅色覆盖 |
| 内联样式迁移 | `Landing`/`MyInfo`/`Term`/`Asset` 等组件内联白色改 CSS 变量/class |

### 3. tmux 会话保持

| 功能 | 说明 |
|------|------|
| tmux 会话管理 | 创建/attach/kill/状态检测，`message-bg default` 抑制黄色指示器 |
| 会话保持参数 | 移动端默认开启 `keep=1`，资产属性可强制覆盖 |
| 在线列表扩展 | 断开的 keep-alive 会话仍显示在在线列表，支持"继续"重连 |
| 手动清理 | `POST /sessions/:id/cleanup` — SSH 上去 kill tmux + 删除记录 |
| TTL 自动清理 | 默认 24h，10 分钟轮询，kill 成功后置 `keep_alive=0` |
| 会话状态标识 | "保持"（绿色）/ "已断开·可恢复"（琥珀色）/ 无标识 |

### 4. 断线重连

| 功能 | 说明 |
|------|------|
| 60s 宽限期 | WebSocket 断开后底层 SSH 保持 60s，支持 `TryReattach` 无缝恢复 |
| tmux 接管 | 宽限期内无重连令牌时，`keep=1` 触发接管（关旧连接 + 新建 SSH + attach） |
| 前端自动重连 | 5 次指数退避（2s/4s/8s/16s/32s），异常断开自动触发 |
| 重连令牌 | HMAC-SHA256 无状态令牌，三重验证（令牌 + JWT + 归属） |
| 强制重绘 | 重连后 `forceRemoteRedraw` — 抖动式 resize 触发 SIGWINCH 全屏重绘 |
| 三不连原则 | 主动关闭 / 收到 Closed / close code 1000-1001 — 均不重连 |

### 5. PWA 支持

| 功能 | 说明 |
|------|------|
| Service Worker | 自定义 `sw.js`，缓存优先策略，离线可用 |
| PWA Manifest | 可安装到主屏，maskable 图标适配 Android/iOS |
| 路由自愈 | `RouteFallback` 组件 — chunk 加载失败 15s 自动恢复 |
| 错误边界 | `ErrorBoundary` 捕获 React 渲染异常 |

### 6. 文件预览与终端增强

| 功能 | 说明 |
|------|------|
| 文件选择器 | 路径补全 + 实时搜索 + 键盘导航（Tab/↑↓/Enter/Esc） |
| 文件预览 | PDF/HTML/Markdown/代码高亮/图片，不依赖 Monaco |
| 字号调节 | 9 档字号（11-22px），自动重排并同步远端 |
| xterm WebGL | GPU 渲染，上下文丢失自动回退 canvas |
| rAF 节流 | 合并同帧多次 `term.write`，减少 DOM 重绘 |

### 7. RDP/Guacamole 稳定性

| 功能 | 说明 |
|------|------|
| nop 保活 | 每 15s 发 `3.nop;`，防 guacd 检测用户无响应断开 |
| resize-method | 固定 `reconnect`（不用 `display-update`，兼容所有 Windows） |
| 流式下载 | `io.Copy` 替代全量缓冲，浏览器即时弹保存框 |
| 监控端隔离 | 监控写失败只清理自身，不误杀主会话 |

---

## 性能优化

| 优化项 | 说明 |
|--------|------|
| SQLite WAL | `journal_mode(WAL)` + `busy_timeout(5000)` + `foreign_keys(1)`，MaxOpenConns=1 |
| MySQL 连接池 | MaxOpenConns=25, MaxIdleConns=10 |
| 索引补齐 | 13 个高频索引，`CREATE INDEX IF NOT EXISTS`，启动安全 |
| GORM 分页修复 | 12 个 repository 的 `Offset/Limit` 在 `Find` 后不生效问题修复 |
| 权限缓存 | `PermissionCache` 5 分钟 TTL，避免每请求三层嵌套循环 |
| guacd TCP_NODELAY | 禁用 Nagle，按键延迟 -40ms |
| WebSocket Buffer | 4096 → 32768，提升 RDP 大帧吞吐 |
| SSH 输出零拷贝 | `WriteMessageBytes` 两段直写，消除多轮全量拷贝 |
| ws 写路径统一锁 | 所有 ws 写收敛到 `Session.WriteMessage`（锁 + 10s WriteDeadline） |
| 分批删除日志 | 防 SQLite `SQLITE_MAX_VARIABLE_NUMBER` (32766) 上限 |
| cron SkipIfStillRunning | 任务执行超一个调度周期不叠加 |
| 前端 lazy loading | 38 个路由组件懒加载，Monitoring prefetch |
| pro-components 异步 | 84KB ProTable/ProCard 样式从主包迁出异步加载 |

---

## 安全加固

| 安全项 | 说明 |
|--------|------|
| encryption-key | 资产/凭据加密密钥，MD5 派生 AES 密钥，支持 `--new-encryption-key` 迁移 |
| trusted-proxies | 反代部署时配置可信代理网段，正确解析 X-Forwarded-For |
| Sourcemap 剔除 | Dockerfile 构建时删除 `.map` 文件，防止前端源码泄露 |
| 权限校验 | `mw.Auth` 检查 Token + URL path 权限，超级管理员绕过 |
| 凭证清理 | `DisDBSess` 断开时清空 password/privateKey 为 `-` |

---

## 配置项

```yaml
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

sshd:
  enable: false
  addr: 0.0.0.0:8089

# debug: true 时前端使用 web/build 目录（live mode）
debug: false
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

## 部署

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

### 本地构建

```bash
# 完整构建（前端 + Go）
sh build.sh

# 仅前端
cd web && yarn build

# 仅后端
go mod tidy
CGO_ENABLED=0 go build -ldflags '-s -w' -o next-terminal main.go
```

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

## 默认账号

| 账号 | 密码 |
|------|------|
| admin | 首次部署后请立即修改 |

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

## 协议

本项目基于 [AGPL-3.0](./LICENSE) 协议开源。原始项目版权归 [dushixiang](https://github.com/dushixiang) 所有。
