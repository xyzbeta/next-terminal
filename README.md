# Next Terminal v1.4.2

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

## v1.4.2 更新内容

| 类别 | 内容 | 说明 |
|------|------|------|
| 新功能 | 浮动文件选择器 | `Ctrl+Shift+F` 或点击闪电(⚡)按钮打开，支持 Tab 补全、↓↑ 导航、Enter 预览远程主机图片，相对路径由后端通过 SFTP RealPath 自动解析 |
| 新功能 | 终端快捷命令入口 | 工具栏闪电(⚡)按钮，点击展开命令菜单，支持点击触发，后续快捷命令可在此扩展 |
| 新功能 | SSH 终端存活指示器 | 右下角实时显示链路延迟（● XXms），2s 刷新，8s 无响应标记离线 |
| 优化 | 图片预览功能重构 | 移除脆弱的 `@` 输入拦截 + 前端 `cwdRef` 推断，改为 DOM 层浮动选择器 + 后端路径解析，彻底解决输入冲突和路径错误问题 |
| 优化 | Ping 保活机制优化 | 自定义请求改为标准 `keepalive@openssh.com`，消除部分 SSH 服务器超时问题 |
| 优化 | 预览/ls 端点路径解析 | 相对路径通过 SFTP `RealPath(".")` 解析，不再依赖前端 `cd` 命令正则追踪 |
| 优化 | 文件选择器搜索 | 支持部分输入实时过滤，AbortController 防止旧结果覆盖，固定高度列表 + 键盘导航自动滚屏 |
| 优化 | 代码质量 | 移除 16 处 `console.log` 调试残留，修复 5 处 ESLint 错误，`let`→`const`（17 处），提取公共函数消除重复逻辑 |

## v1.4.1 更新内容

| 类别 | 内容 | 说明 |
|------|------|------|
| 新功能 | SSH 终端存活指示器 | 右下角实时显示链路延迟（● XXms），2s 刷新，8s 无响应标记离线 |
| 优化 | Ping 保活机制优化 | 自定义请求改为标准 `keepalive@openssh.com`，消除部分 SSH 服务器的超时问题 |

## v1.4.0 优化内容

基于 v1.3.9 进行性能优化、Bug 修复和稳定性增强，累计 30+ 项改动。

### 性能优化

| 类别 | 优化项 | 说明 |
|------|--------|------|
| RDP 传输 | WebSocket Buffer 32KB | 扩大 WebSocket 读写缓冲，RDP 大帧吞吐提升 3-5x |
| RDP 传输 | TCP_NODELAY | 禁用 Nagle 算法，按键延迟 -40ms |
| RDP 传输 | WebSocket 压缩 (permessage-deflate) | 无损压缩，带宽节省 40-50% |
| RDP 编码 | WebP 优先 | guacd 优先使用 WebP 编码画面帧，同质量下比 JPEG 小 25-35% |
| RDP 编码 | JPEG/WebP 质量优化 | 质量参数从默认 90 调整为 80，肉眼无感知，帧大小 -30% |
| RDP 连接 | guacd nop 保活 | 每 15s 发无操作指令，防止 guacd 空闲断开 |
| SSH 终端 | TermHandler chunk 读取 + 混合刷新 | 逐字符读取改为 4KB chunk + 32KB 阈值立即刷新，批量输出延迟 -60ms |
| SSH 终端 | 加密套件优先排序 | chacha20-poly1305 优先，兼顾有无 AES-NI 的 CPU |
| SSH 连接 | Server Keepalive | 每 30s 发 keepalive@openssh.com 检测僵死连接 |
| SSH 文件 | 下载流式传输 | 文件下载即时弹出保存框，不再先缓冲整个文件到内存 |
| 前端 | xterm.js rAF 渲染节流 | requestAnimationFrame 合并渲染，大数据输出不卡 UI |
| 数据库 | MySQL 连接池 | MaxOpenConns=25, MaxIdleConns=10 |
| 认证 | 权限缓存 | 用户可访问 URL path 集合缓存（5 分钟 TTL），避免每次请求三层嵌套循环 |

### Bug 修复

| 类别 | 修复项 |
|------|--------|
| 基础工具 | `FileExists` 函数语义修正 |
| 基础工具 | `PKCS5UnPadding` 增加空数据和损坏数据边界检查 |
| 并发安全 | Security Manager 读写锁保护 |
| 并发安全 | `UpdateLastActive` 加锁保护 |
| 资源泄漏 | SOCKS5 连接失败路径关闭 TCP 连接 |
| 资源泄漏 | 上传文件句柄 Close |
| 资源泄漏 | Term 组件 pingInterval unmount 清理 |
| 业务逻辑 | 登录策略多条匹配时改为最高优先级生效 |
| 业务逻辑 | 会话文件操作不支持协议返回明确错误 |
| 业务逻辑 | SSH 凭据获取失败不再静默吞错 |
| 业务逻辑 | PTY/Shell 失败通过 WebSocket 通知客户端 |
| 业务逻辑 | 存储上传找不到存储时返回错误 |
| 前端 | `AuthorisedUsers`/`AuthorisedUserGroups` 缺失 `await` 修复 |
| 前端 | TB 存储配额计算修正 |
| 性能 | N+1 批量删除改为 `WHERE id IN (?)` |

### 代码质量

| 类别 | 内容 |
|------|------|
| 死代码清理 | 移除未使用的 `Pbkdf2` 函数及 `crypto/rand`、`crypto/sha256`、`pbkdf2` 依赖 |
| 去重 | nop 保活提取为公共函数 `startNopKeepalive` |
| 清理 | 移除 62 行注释掉的无用代码 |
| 清理 | 删除不相关文件（测试目录、调试文件、本地环境配置、playground 等） |

### 已知限制

| 项目 | 说明 |
|------|------|
| RDP resize-method | 使用 `reconnect` 而非 `display-update`。前者在所有 Windows 版本均可靠（缩放时 1-2s 短暂重连），后者需 RDP 8.0+ 在某些环境会导致连接断开 |
| RDP 断线重连 | `ValidateReconnectToken` 返回 false，重连功能暂不可用 |

---

## 功能特性

- 授权凭证管理
- 资产管理（支持 RDP、SSH、VNC、Telnet、Kubernetes 协议）
- 指令管理
- 批量执行命令
- 在线会话管理（监控、强制断开）
- 离线会话管理（查看录屏）
- 双因素认证 (TOTP)
- 资产标签
- 资产授权
- 多用户 & 用户分组
- 计划任务
- SSH Server（内嵌 gliderlabs/ssh）
- 登录策略（IP 限制、时间段限制）
- 系统监控
- 接入网关（SSH 隧道代理内网资产）

---

## 快速开始

### Docker 部署（推荐）

```bash
# 1. 创建部署目录
mkdir -p /serverhub/next-terminal/data/sqlite /serverhub/next-terminal/guacd

# 2. 创建 docker-compose.yaml
cat > /serverhub/next-terminal/docker-compose.yaml << 'EOF'
services:
  guacd:
    container_name: guacd
    image: dushixiang/guacd:latest
    network_mode: host
    volumes:
      - /serverhub/next-terminal/guacd:/usr/local/next-terminal/data
    restart: always

  next-terminal:
    container_name: next-terminal
    image: next-terminal:v1.4.2
    network_mode: host
    environment:
      DB: sqlite
      SQLITE_FILE: /usr/local/next-terminal/data/sqlite/next-terminal.db
      GUACD_HOSTNAME: 127.0.0.1
      GUACD_PORT: 4822
      SSHD_ENABLE: "true"
      SSHD_ADDR: 0.0.0.0:8089
    volumes:
      - /etc/localtime:/etc/localtime
      - /serverhub/next-terminal/data:/usr/local/next-terminal/data
    restart: always
EOF

# 3. 启动
cd /serverhub/next-terminal
docker-compose up -d
```

访问 `http://<服务器IP>:8088`，默认账号 `admin` / `admin`。

### 手动编译

```bash
# 前端
cd web && npm install && npm run build

# 后端
go mod tidy
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags '-s -w' -o next-terminal main.go
```

---

## 配置说明

使用 Viper，优先级：环境变量 > config.yml > pflag 命令行参数。

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `db` | 数据库类型 `sqlite` / `mysql` | `sqlite` |
| `server.addr` | HTTP 监听地址 | `0.0.0.0:8088` |
| `sshd.enable` | 启用内嵌 SSH 服务器 | `true` |
| `sshd.addr` | SSH 服务监听地址 | `0.0.0.0:8089` |
| `guacd.hostname` | guacd 服务地址 | `127.0.0.1` |
| `guacd.port` | guacd 服务端口 | `4822` |
| `encryption-key` | 数据加密密钥 | — |

---

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Go 1.20+, Echo (HTTP), GORM (ORM), gorilla/websocket |
| 前端 | React, Ant Design Pro, xterm.js, guacamole-common-js |
| 协议 | Guacamole (RDP/VNC/Telnet/K8s), 原生 Go SSH |
| 数据库 | SQLite / MySQL |
| 部署 | Docker, Docker Compose |

---

## 协议

本项目基于 [AGPL-3.0](./LICENSE) 协议开源。原始项目版权归 [dushixiang](https://github.com/dushixiang) 所有。
