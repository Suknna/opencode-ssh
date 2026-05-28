# opencode-ssh

[English](./README.md) · [简体中文](./README.zh-CN.md)

> 一个 [opencode](https://opencode.ai) 插件，给 AI 提供 8 个受控的 SSH 工具来操作远程 Linux 主机：列表、连接、执行、PTY、历史、上传、下载、关闭。

[![CI](https://github.com/Suknna/opencode-ssh/actions/workflows/ci.yml/badge.svg)](https://github.com/Suknna/opencode-ssh/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/opencode-ssh.svg)](https://www.npmjs.com/package/opencode-ssh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## 这个插件给 opencode 提供了什么

opencode 是一个 AI 编码代理，默认情况下它无法 SSH 到远程主机。本插件通过 opencode 官方插件 API 注册了 8 个工具，让模型可以：

- **列出** 已配置的主机（`ssh_list`）。
- **按需连接** 到目标主机（`ssh_connect`）—— 启动时不会自动连接。
- **执行** 远程命令，支持阻塞和后台两种模式（`ssh_exec`）。
- **驱动 PTY** 处理需要伪终端的命令，例如 `sudo`、`passwd`、`apt -y` 等交互式场景（`ssh_pty`）。
- **查阅** 历史命令输出，支持分页（`ssh_history`）。
- **传输文件**，单文件 SFTP 上传/下载（`ssh_upload`、`ssh_download`）。
- **关闭** 连接并清理本地日志（`ssh_close`）。

底层使用 [`ssh2`](https://github.com/mscdex/ssh2)，支持密码与私钥认证（推荐通过环境变量传递敏感凭据），所有命令的输出会落盘到项目内的 `.opencode/ssh/` 目录，方便模型在后续对话中回看长时间运行命令的输出。

## 5 分钟上手

### 1. 先装好 opencode

如果你还没装过 opencode：

```sh
curl -fsSL https://opencode.ai/install | bash
```

其它安装方式见 [opencode 文档](https://opencode.ai/docs/)。opencode 运行在 [Bun](https://bun.sh) `>=1.2.0` 之上，安装脚本会自动处理。

### 2. 在项目里安装本插件

进入你打算用 opencode 的项目目录，安装本插件：

```sh
bun add opencode-ssh
```

然后在项目根目录创建或编辑 `opencode.json`：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-ssh"]
}
```

### 3. 配置一个主机

在项目根目录创建 `opencode-ssh.json`，先用最简单的写法配置一个主机，密码通过环境变量传入：

```json
{
  "hosts": [
    {
      "name": "dev",
      "host": "192.168.1.100",
      "username": "ubuntu",
      "description": "本地开发机",
      "passwordEnv": "DEV_SSH_PASSWORD"
    }
  ]
}
```

启动 opencode 之前，先把密码导出到环境变量：

```sh
export DEV_SSH_PASSWORD='你的真实密码'
```

### 4. 在 opencode 里使用

在该项目下启动 opencode，对话里直接告诉模型怎么用即可：

> 列出我的 SSH 主机，连接到 `dev`，执行 `uname -a`。

模型会按顺序调用 `ssh_list` → `ssh_connect` → `ssh_exec`。你不需要手动调用工具，opencode 会自动路由。

到这里就能跑起来了。下面是更完整的配置参考与安全建议。

## 完整配置参考

### 配置文件位置

插件启动时会读两个独立的 JSON 文件：

| 范围   | 路径                                    |
| ------ | --------------------------------------- |
| 全局   | `~/.config/opencode/opencode-ssh.json`  |
| 项目   | `<项目根>/opencode-ssh.json`            |

两个文件都可以缺失。如果都存在，**项目文件的 `hosts` 会追加（append）到全局 `hosts` 之后**，不是覆盖。合并后所有主机的 `name` 必须唯一；如果重名，插件会报 `HOST_DUPLICATE` 并拒绝启动。

`history` 字段：项目文件显式定义了 `history` 时优先用项目的；否则回退到全局 `history`，再否则用默认值 `{ enabled: true, cleanupOnClose: true }`。

### 完整主机示例

```json
{
  "hosts": [
    {
      "name": "prod-api",
      "host": "1.2.3.4",
      "port": 22,
      "username": "deploy",
      "description": "生产 API 服务器",
      "passwordEnv": "PROD_API_PASSWORD",
      "privateKeyPath": "~/.ssh/prod_api",
      "privateKeyPassphraseEnv": "PROD_API_KEY_PASSPHRASE",
      "hostKey": {
        "mode": "accept-new"
      }
    }
  ],
  "history": {
    "enabled": true,
    "cleanupOnClose": true
  }
}
```

### 主机字段

必填：

- `name` — 主机的唯一标识，模型在所有工具调用里都用这个值。
- `host` — 主机名或 IP。
- `username` — 远程登录用户。

至少必须配置一种凭据：`password`、`passwordEnv` 或 `privateKeyPath`，否则配置加载阶段会抛 `AUTH_MISSING`。

可选：

| 字段                       | 类型                                  | 说明                                                              |
| -------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| `port`                     | 整数                                  | 默认 `22`。                                                       |
| `description`              | 字符串                                | `ssh_list` 输出里的描述。                                         |
| `password`                 | 字符串                                | 明文密码，仅推荐本地实验。                                        |
| `passwordEnv`              | 字符串                                | 存放密码的环境变量名。**推荐**。                                  |
| `privateKeyPath`           | 字符串                                | 绝对路径或 `~/` 前缀路径。                                        |
| `privateKeyPassphrase`     | 字符串                                | 明文 passphrase，仅推荐本地实验。                                 |
| `privateKeyPassphraseEnv`  | 字符串                                | 存放 passphrase 的环境变量名。**推荐**。                          |
| `hostKey.mode`             | `"accept-new"` \| `"strict"`          | 见下方[Host key 风险](#host-key-风险)。**当前 `"strict"` 会让连接立即失败，因为严格 pinning 暂未实现。** |
| `hostKey.fingerprint`      | 字符串                                | 字段保留，目前运行时不会真正强制校验。                            |

### 凭据解析顺序

凭据按"每一类内部"做解析，然后把 `ssh2` 能用的字段都传给底层客户端：

- 密码：`passwordEnv` 已配置且环境变量有值 → 使用环境变量；否则使用字面 `password`。
- 私钥 passphrase：`privateKeyPassphraseEnv` 已配置且环境变量有值 → 使用环境变量；否则使用字面 `privateKeyPassphrase`。
- 配置了 `privateKeyPath` 时，连接时会读取私钥文件。

`ssh2` 在一次连接中可能尝试**多种认证方式**，所以同时配置私钥和密码是允许的，最终由远程 SSH 服务器决定接受哪种方式。本插件并没有"私钥优先于密码"的严格优先级。

### 历史字段

```json
{
  "history": {
    "enabled": true,
    "cleanupOnClose": true
  }
}
```

两个字段都默认 `true`。详见[历史与清理行为](#历史与清理行为)。

## 模型可用的工具

8 个工具都注册在 `src/tools/create-tools.ts`，参数 schema 使用 Zod。模型按工具名调用，不需要你手动调。

| 工具名          | 用途                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ssh_list`      | 列出已配置的主机以及当前连接状态。                                                                                         |
| `ssh_connect`   | 打开到一个主机的连接。其他工具调用前必须先连接。                                                                           |
| `ssh_exec`      | 执行远程命令，支持 `wait`（阻塞）和 `background`（后台）模式。返回 `commandId`、`stdout`、`stderr`、`exitCode`、`status`。 |
| `ssh_pty`       | 打开并驱动一个 PTY 会话，用于 `sudo`、`passwd`、REPL 等。支持 `start`、`write`、`read`、`resize`、`kill`。                  |
| `ssh_history`   | 列出历史命令和 PTY 会话，或按 id 分页读取输出。**读取的是当前进程内存中的记录。**                                          |
| `ssh_upload`    | 通过 SFTP 上传单个本地文件到已连接主机。                                                                                   |
| `ssh_download`  | 通过 SFTP 下载单个远程文件。                                                                                               |
| `ssh_close`     | 关闭一个主机（或所有主机）的连接。会取消后台命令、关闭 PTY 会话、结束 SSH 连接，并在 `cleanupOnClose: true` 时移除该连接的本地历史目录。 |

### 关键参数限制

- `ssh_connect.timeoutSeconds`：1–120，默认 `30`。
- `ssh_exec.timeoutSeconds`：1–86400。
- `ssh_exec.cwd` 当前会返回 `CONFIG_INVALID`。请在命令里直接 `cd`（如 `cd /tmp && do-thing`）。
- `ssh_pty` `cols` 20–300，`rows` 5–100；`read` 的 `limit` ≤ 500。
- `ssh_pty.write.data` 支持转义：`\n`、`\r`、`\t`、`\xNN`、`\uNNNN`。
- `ssh_history` `limit` 1–500。Schema 上 `id` 是可选的，但 `action: "read"` 时缺 `id` 会返回 `CONFIG_INVALID`。
- PTY 的内存缓冲约 1,000,000 字符，超出时丢弃最旧数据，`read` 在被截断时会在第一行注入 `[pty output truncated: oldest data discarded]` 提示。

### 错误码

每个工具失败时都会返回结构化的 `<ssh_error>` 块。错误码经过白名单化，例如 `HOST_NOT_FOUND`、`CONNECT_TIMEOUT`、`CONNECT_FAILED`、`CONFIG_INVALID`、`COMMAND_FAILED`、`PTY_NOT_FOUND`、`PTY_FAILED`、`HISTORY_NOT_FOUND`、`TRANSFER_FAILED`、`CLOSE_FAILED`。底层错误信息已经过脱敏，凭据不会通过错误输出泄漏。

## 历史与清理行为

### 落盘路径

当 `history.enabled: true` 时，每个命令和 PTY 会话都会写一个日志文件到：

```
<项目根>/.opencode/ssh/<主机名>/<连接ID>/<记录ID>.log
```

`<记录ID>` 是执行时分配的标识（如 `cmd_xxx`、`pty_xxx`），一条命令一个文件，便于精细化清理。

### 行为矩阵

| `history.enabled`  | `history.cleanupOnClose` | 连接活动时                                                                          | `ssh_close` 之后                                                                                                                          |
| :----------------: | :----------------------: | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `true`（默认）     | `true`（默认）           | `ssh_exec` / `ssh_pty` 的输出落盘 + 内存索引；`ssh_history` 从内存读取。            | 该连接的历史目录 `.opencode/ssh/<主机名>/<连接ID>/` 被删除；内存中的记录也被清空。                                                        |
| `true`             | `false`                  | 同上。                                                                              | 磁盘日志保留在 `.opencode/ssh/...` 下用于离线审计，但内存记录已被清理，因此 `ssh_history` 看不到这些记录。                                |
| `false`            | 任意                     | 不写盘；`ssh_history` 只能看到 manager 维护的内存缓冲。                             | 关闭后该连接的内存状态被丢弃，之前缓冲过的输出无法再取回。                                                                                |

`opencode` 的 `dispose` 与 `session.deleted` 事件也会走同一条关闭路径，所以关闭 opencode 或删除会话时也会按上面的规则清理。

### 隐私与合规建议

远程命令输出可能包含密钥、文件内容或不希望长期保留的主机名。默认行为（`enabled: true`、`cleanupOnClose: true`）会在连接活动时保留完整输出供 `ssh_history` 使用，关闭时清理。对敏感工作流可以直接 `history.enabled: false`。

记得把 `.opencode/ssh/` 加入 `.gitignore`（本仓库的 `.gitignore` 已经包含）。**如果 `opencode-ssh.json` 里出现了字面 `password` 或 `privateKeyPassphrase`，绝对不要提交到 Git。**

## 安全建议

### 凭据用环境变量

- 共享/生产/CI 配置，强烈建议用 `passwordEnv` 与 `privateKeyPassphraseEnv`。
- 字面 `password` / `privateKeyPassphrase` 视为本地一次性配置，配置文件加进 `.gitignore`。
- 即便用环境变量，也尽量避免在共享 shell history 或 CI 日志里以 `export FOO=...` 明文打印；可以用密钥管理器或本地 `.envrc`（同样加 gitignore）。

### Host key 风险

`hostKey.mode` 默认 `"accept-new"`。该模式下 SSH 客户端会信任服务端在首连时给出的任意 host key。本地开发方便，但首连时存在中间人攻击风险。

> **重要提示**：当前版本如果你把 `"hostKey.mode"` 设为 `"strict"`，`ssh_connect` 会立即失败，因为插件层面的严格 pinning 暂未实现。在严格 pinning 落地前，请保留 `"accept-new"` 或不写 `hostKey` 字段，并通过 SSH 层面（例如受控的 `~/.ssh/known_hosts`）锁定主机指纹。

### 不要提交的文件

- `opencode-ssh.json`（如果包含字面凭据）。
- `.opencode/ssh/`（每个连接的本地日志）。
- `.tmp/`（测试产物）。

## 本地开发

```sh
git clone https://github.com/Suknna/opencode-ssh
cd opencode-ssh
bun install
bun run typecheck
bun test
bun run build
```

集成测试需要真实 OpenSSH 容器，**不会回退到 mock**：

```sh
bun run test:integration
```

需要可用的 Docker（Docker Desktop / OrbStack / Colima 都可以）。没有 Docker 时集成测试会按设计失败。

如果需要在另一个项目里调试本地构建版本，把构建产物指给那个项目的 `opencode.json`：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./.opencode/plugins/opencode-ssh/dist/index.js"]
}
```

`bun run build` 后 `dist/index.js` 会出现在仓库根的 `dist/` 目录（或你放置构建产物的位置）。

## License

MIT — 见 [LICENSE](./LICENSE)。

## 参考

- [opencode 插件 API](https://opencode.ai/docs/plugins/)
- [opencode SDK](https://opencode.ai/docs/sdk/)
- [`ssh2` 库](https://github.com/mscdex/ssh2)
