# opencode SSH 插件设计

日期：2026-05-27

## 背景与目标

本项目从空目录初始化，目标是实现一个 opencode 插件，为模型提供可控的远程 Linux 服务器操作能力。插件通过 opencode 官方插件机制注册 SSH 工具，模型可以列出主机、主动连接、执行命令、处理 PTY 交互、上传下载文件、查看历史输出，并在关闭连接时清理本地历史日志。

第一版聚焦稳定的工具层能力，不实现 Web UI，不自动连接主机，不引入无关交互界面。

## 已批准的关键决策

- 使用独立配置文件：全局 `~/.config/opencode/opencode-ssh.json`，项目内 `<project>/opencode-ssh.json`。
- 项目配置追加到全局配置，不覆盖全局配置。
- 主机必须显式配置 `name`，全局与项目合并后 `name` 必须唯一；重复时插件初始化失败。
- 插件启动时不自动连接任何主机；模型通过 `ssh_list` 查看主机，再用 `ssh_connect` 主动连接。
- 使用 SSH 库直接管理连接、exec、PTY shell 和 SFTP；第一阶段必须验证 Bun 兼容性。
- 工具集包含 `ssh_list`、`ssh_connect`、`ssh_exec`、`ssh_pty`、`ssh_history`、`ssh_upload`、`ssh_download`、`ssh_close`。
- `ssh_exec` 支持阻塞执行和后台执行。
- `ssh_pty` 处理需要伪终端或动态输入的交互动作，例如 `passwd`、`sudo`、确认提示和控制字符。
- 默认完整持久化命令历史和输出到项目目录 `.opencode/ssh/<hostName>/<connectionId>/`；不作为长期常驻日志，`ssh_close` 关闭连接时清理该连接/会话下全部日志。
- 凭据支持 `password`、`passwordEnv`、`privateKeyPath`、`privateKeyPassphrase`、`privateKeyPassphraseEnv`，环境变量优先。

## 官方依据

- opencode 插件文档：`https://opencode.ai/docs/plugins/`
  - 插件可返回 `tool: { ... }` 注册自定义工具。
  - 插件上下文包含 `project`、`client`、`$`、`directory`、`worktree`。
  - 插件支持 `dispose`、`event`、`config`、工具执行前后等 hooks。
- opencode SDK 文档：`https://opencode.ai/docs/sdk/`
  - SDK client 可调用 `client.app.log()`、`client.session.prompt()`、`client.event.subscribe()` 等。
- `ctx7 library ssh2 "How to implement SSH client exec shell PTY and SFTP in TypeScript"`
  - 解析到 Context7 Library ID：`/mscdex/ssh2`。
- `ctx7 docs /mscdex/ssh2 "How to implement SSH client exec shell PTY password private key authentication and SFTP upload download in TypeScript"`
  - 确认 `ssh2` 支持 `exec()`、`shell()`、`pty`、`sftp()`、`fastGet()`、`fastPut()`、密码、私钥和 passphrase。

## 插件入口

采用 opencode 新版 npm/path 插件模块形状：

```ts
export default {
  id: "opencode-ssh",
  server: async (ctx, options) => {
    return {
      tool: createSSHTools(manager),
      dispose: async () => {
        await manager.dispose()
      },
      event: async ({ event }) => {
        // session.deleted 等事件触发时清理连接和日志。
      },
    }
  },
}
```

每个工具使用 `@opencode-ai/plugin` 的 `tool` helper。参数 schema 使用 `tool.schema`，即 Zod，并为关键参数提供 `.describe(...)`。

## 模块结构

```text
src/
  index.ts                 # 插件入口，默认导出 { id, server }
  plugin.ts                # 创建 manager、加载配置、注册工具和生命周期 hooks
  config/
    loader.ts              # 读取全局 + 项目 opencode-ssh.json
    schema.ts              # 配置校验和默认值
  ssh/
    manager.ts             # 连接池、会话、命令、历史生命周期
    connection.ts          # SSH 连接封装
    exec.ts                # 普通命令执行
    pty.ts                 # PTY / shell 交互
    sftp.ts                # 上传下载
  history/
    store.ts               # .opencode/ssh/<hostName>/<connectionId>/ 日志写入与清理
    formatter.ts           # <ssh_output> 等结构化输出
  tools/
    ssh-list.ts
    ssh-connect.ts
    ssh-exec.ts
    ssh-pty.ts
    ssh-history.ts
    ssh-upload.ts
    ssh-download.ts
    ssh-close.ts
```

`SSHManager` 是唯一持有连接和会话状态的对象。工具层只负责参数校验、调用 manager、格式化结果，避免每个工具各自维护连接状态。

## 配置格式

全局配置路径：

```text
~/.config/opencode/opencode-ssh.json
```

项目配置路径：

```text
<project>/opencode-ssh.json
```

示例：

```json
{
  "hosts": [
    {
      "name": "prod-api",
      "host": "1.2.3.4",
      "port": 22,
      "username": "root",
      "description": "生产 API 服务器",
      "passwordEnv": "PROD_API_PASSWORD",
      "privateKeyPath": "~/.ssh/prod_api",
      "privateKeyPassphraseEnv": "PROD_API_KEY_PASSPHRASE"
    }
  ],
  "history": {
    "enabled": true,
    "cleanupOnClose": true
  }
}
```

配置规则：

- `hosts` 必须是数组。
- 每个 host 必须包含 `name`、`host`、`username`。
- `port` 默认 `22`。
- `description` 用于帮助模型理解主机用途。
- 全局和项目配置合并后，`name` 必须唯一。
- 至少提供一种认证方式，或显式允许后续扩展为 agent 认证。

凭据解析优先级：

1. `privateKeyPath` + `privateKeyPassphraseEnv`
2. `privateKeyPath` + `privateKeyPassphrase`
3. `privateKeyPath`
4. `passwordEnv`
5. `password`

安全展示规则：

- `ssh_list` 不展示密码、环境变量值、私钥内容、完整 passphrase。
- 明文 `password` 和 `privateKeyPassphrase` 仅建议本地临时使用。
- README 必须建议生产环境使用环境变量。

### 历史配置语义

`history.enabled` 控制是否把命令输出写入项目目录，默认值为 `true`。

- `true`：`ssh_exec`、`ssh_pty` 的输出会写入 `.opencode/ssh/<hostName>/<connectionId>/`，`ssh_history` 可从内存索引和本地日志中检索历史记录。
- `false`：不写入本地日志；`ssh_history` 仅能读取当前进程内仍保留的内存缓冲，opencode 进程退出或连接关闭后不可再检索。

`history.cleanupOnClose` 控制 `ssh_close` 是否清理该连接/会话下的本地日志，默认值为 `true`。

- `true`：`ssh_close` 关闭连接时删除该连接/会话对应的 `.opencode/ssh/<hostName>/<connectionId>/` 目录；关闭后 `ssh_history` 不再能检索这些日志。
- `false`：`ssh_close` 只关闭连接，不删除本地日志；`ssh_history` 后续仍可检索已落盘记录，直到用户手动删除或未来清理策略处理。

默认配置等价于：

```json
{
  "history": {
    "enabled": true,
    "cleanupOnClose": true
  }
}
```

也就是说，默认会在连接存活期间保留完整历史输出供 `ssh_history` 检索，并在 `ssh_close` 时清理该连接/会话下全部本地日志。

## 工具契约

### `ssh_list`

用途：列出配置中可用主机、当前连接状态、活动命令和历史摘要。

返回示例：

```xml
<ssh_hosts>
  <host name="prod-api" host="1.2.3.4" user="root" connected="false">
    生产 API 服务器
  </host>
</ssh_hosts>
```

### `ssh_connect`

用途：模型通过主机 `name` 主动建立 SSH 连接。插件启动时不会自动连接。

参数：

- `hostName`: 主机名。
- `timeoutSeconds`: 可选连接超时。

行为：连接成功后在后台保持，直到 `ssh_close`、`dispose`、`session.deleted` 或进程退出清理。

### `ssh_exec`

用途：执行普通远程命令。

参数：

- `hostName`
- `command`
- `mode`: `"wait" | "background"`
- `timeoutSeconds`
- `cwd`: 可选远端工作目录。
- `env`: 可选环境变量。

行为：

- `mode: "wait"`：等待命令完成，返回 stdout、stderr、exitCode，并写入历史。
- `mode: "background"`：立即返回 commandId，输出持续写入历史，可用 `ssh_history` 读取。

### `ssh_pty`

用途：处理需要 PTY 或动态输入的命令。

参数通过 `action` 区分：

- `start`：启动 PTY shell 或 PTY 命令。
- `write`：写入原始输入，支持 `\n`、`\r`、`\t`、`\x03`、`\x04`、ANSI escape 等。
- `read`：读取缓冲输出。
- `resize`：调整窗口大小。
- `kill`：结束 PTY 会话。

PTY 输出写入历史日志，并可通过 `ssh_history` 读取。

### `ssh_history`

用途：查看历史命令、后台任务和 PTY 会话，并读取指定记录输出。

能力：

- 列出 commandId / ptySessionId。
- 按 ID 读取输出。
- 支持分页、行号、最大行宽截断。
- 支持简单 pattern 过滤。

检索来源：

- 当 `history.enabled: true` 时，优先使用 manager 的内存索引定位记录，再从 `.opencode/ssh/<hostName>/<connectionId>/` 下的日志文件读取完整输出。
- 当 `history.enabled: false` 时，只读取当前进程内缓冲；该模式适合不希望远程输出落盘的场景。
- 当 `history.cleanupOnClose: true` 且连接已通过 `ssh_close` 关闭时，该连接/会话的本地日志已被删除，`ssh_history` 应返回 `HISTORY_NOT_FOUND` 或提示记录已随连接关闭清理。
- 当 `history.cleanupOnClose: false` 时，`ssh_history` 可在连接关闭后继续读取仍保留在磁盘上的历史日志。

输出示例：

```xml
<ssh_output id="cmd_123" host="prod-api" status="running">
00001| <第一行输出>
00002| <第二行输出>
</ssh_output>
```

### `ssh_upload` / `ssh_download`

用途：通过 SFTP 上传和下载文件。

第一版范围：

- 支持单文件上传。
- 支持单文件下载。
- 默认使用已连接 SSH 会话。
- 目录递归、断点续传、进度流式更新作为后续扩展。

### `ssh_close`

用途：关闭指定主机连接或全部连接。

行为：

- 终止该连接下未完成后台命令。
- 关闭 PTY 会话。
- 关闭 SFTP session。
- 关闭 SSH connection。
- 清理该连接/会话下全部 `.opencode/ssh/<hostName>/<connectionId>/` 历史日志。

## 历史与日志生命周期

默认完整持久化历史和输出，但不是长期常驻日志。

建议路径：

```text
<project>/.opencode/ssh/<hostName>/<connectionId>/<YYYY-MM-DD>.log
```

规则：

- `ssh_exec mode=wait` 写入历史。
- `ssh_exec mode=background` 边执行边写入历史。
- `ssh_pty` 输入输出均写入历史。
- `ssh_history` 从内存索引和日志文件读取。
- `ssh_close` 清理该连接/会话下全部历史日志。
- `dispose` 和 `session.deleted` 执行同等清理。
- opencode 异常退出可能留下日志；下一次插件启动可扫描并清理已失去活动连接标记的旧目录。

项目初始化时必须写入 `.gitignore`，排除：

```gitignore
.opencode/ssh/
.tmp/
```

## 错误处理

错误输出使用结构化 XML 风格，便于模型理解：

```xml
<ssh_error code="AUTH_FAILED" host="prod-api">
认证失败：请检查 username、passwordEnv 或 privateKeyPath。
</ssh_error>
```

主要错误类型：

- `CONFIG_INVALID`
- `HOST_DUPLICATE`
- `HOST_NOT_FOUND`
- `AUTH_MISSING`
- `AUTH_FAILED`
- `CONNECT_TIMEOUT`
- `CONNECT_FAILED`
- `COMMAND_TIMEOUT`
- `COMMAND_FAILED`
- `PTY_NOT_FOUND`
- `PTY_CLOSED`
- `WRITE_FAILED`
- `SFTP_FAILED`
- `HISTORY_NOT_FOUND`
- `HISTORY_IO_FAILED`

原则：

- 不吞写入错误。
- 不把认证失败伪装为普通命令失败。
- 非阻塞命令失败后，`ssh_history` 必须能看到失败状态和错误摘要。
- 如果 SSH 服务端没有返回 exit status，允许 `exitCode: null`，并在输出中标注状态未知。

## 生命周期

插件生命周期：

- 初始化：读取配置、校验配置、创建 manager、注册工具。
- `ssh_connect`：建立连接并记录到 manager。
- 工具执行：所有状态变更经 manager 完成。
- `event`：监听 `session.deleted` 等事件，按 session 清理连接和历史。
- `dispose`：关闭所有连接、终止后台任务、清理临时历史。

工具执行上下文：

- 使用 `context.abort` 支持取消长命令。
- 使用 `context.metadata(...)` 更新工具标题和元数据。
- 可预留 `context.ask(...)` 处理高风险操作，但第一版不承诺完全复刻内置 `bash` 的权限体验。

## 测试策略

### 第一阶段：项目与工具基础验证

- TypeScript 类型检查。
- 插件入口结构测试。
- 工具 schema 测试。
- 配置加载和合并测试。
- 重名 host 报错测试。
- 凭据优先级测试。
- 结构化输出格式测试。
- `.gitignore` 覆盖日志目录测试。

### 第二阶段：SSH 库兼容性验证

必须在 Bun 环境实测：

- 安装和导入 SSH 库。
- 密码登录。
- 私钥登录。
- passphrase 私钥登录。
- `exec()` stdout/stderr/exitCode。
- `exec({ pty: true })` 或 `shell()` 交互输入输出。
- SFTP upload/download。
- 超时和断线清理。

若 SSH 库在 Bun/opencode 插件环境下无法稳定工作，必须暂停实现并向用户报告，再切换到系统 `ssh/scp/sftp` 方案。

### 第三阶段：真实集成测试

按项目全局规范，优先使用 Docker 运行真实 OpenSSH server，而不是用 mock 代替集成测试。

覆盖：

- `ssh_connect`
- 阻塞 `ssh_exec`
- 后台 `ssh_exec` + `ssh_history`
- `ssh_pty` 交互输入
- `ssh_upload`
- `ssh_download`
- `ssh_close` 清理日志

临时产物全部写入项目 `.tmp/`，不得写入 `/tmp`。

## 风险与缓解

### SSH 库 Bun 兼容性

`ssh2` 文档目标是 Node.js，并未承诺 Bun 兼容。实现前必须做最小兼容性 spike。若失败，切换到系统 OpenSSH 方案。

### Host key 校验

不能长期默认静默接受 host key。第一版可支持 `hostKey.mode`，例如：

```json
{
  "hostKey": {
    "mode": "accept-new"
  }
}
```

生产文档应建议固定 host fingerprint。若库默认自动接受 host key，必须在 README 标注风险，并在实现计划中优先补充安全策略。

### 明文凭据

明文 `password` 和 `privateKeyPassphrase` 会带来泄露风险。插件支持它们是为了满足快速上手需求；文档必须建议使用 `passwordEnv` 和 `privateKeyPassphraseEnv`。

### 完整输出日志

完整输出可能包含敏感信息。按需求默认写入项目 `.opencode/ssh/<hostName>/<connectionId>/`，但必须：

- 加入 `.gitignore`。
- `ssh_close` 清理。
- `dispose` 清理。
- 下次启动清理旧残留目录。

## 非目标

- 第一版不做 Web UI。
- 第一版不做目录递归上传下载。
- 第一版不做断点续传。
- 第一版不自动连接任何主机。
- 第一版不实现长期审计日志。
- 第一版不覆盖 opencode 内置工具名。

## 验收标准

- 空项目被初始化为可构建的 TypeScript/Bun 插件项目。
- 插件以新版默认导出 `{ id, server }` 暴露。
- opencode 可加载插件并看到全部 SSH 工具。
- 配置文件按全局 + 项目追加合并，重复 host name 报错。
- Docker OpenSSH server 集成测试覆盖核心工具。
- `ssh_close` 能关闭连接并清理该连接/会话下日志。
- 所有验证命令通过，至少包括类型检查、单元测试和集成测试。
