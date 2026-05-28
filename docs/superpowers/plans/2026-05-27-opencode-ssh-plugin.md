# opencode SSH 插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Explicitly invoke/load superpowers:goal-driven-development before implementation tasks. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 初始化并实现一个 TypeScript/Bun opencode SSH 插件，注册远程 SSH 操作工具，支持配置合并、主动连接、阻塞/后台命令、PTY 交互、历史检索、SFTP 上传下载和关闭清理。

**Architecture:** 插件采用 opencode 新版默认导出 `{ id, server }`，工具层只做参数校验和返回格式化，所有连接、命令、PTY、SFTP、历史状态由单例 `SSHManager` 管理。第一阶段先验证 `ssh2` 在 Bun 下的兼容性；若兼容性验证失败，停止实现并向用户报告，不静默切换方案。

**Tech Stack:** Bun、TypeScript、`@opencode-ai/plugin`、`@opencode-ai/sdk`、`ssh2`、Zod via `tool.schema`、Docker/OpenSSH server 集成测试。

---

## File Structure

- Create: `package.json` — 包元数据、脚本、依赖。
- Create: `tsconfig.json` — 开发类型检查配置。
- Create: `tsconfig.build.json` — 插件发布构建配置。
- Create: `.gitignore` — 忽略 `.tmp/`、`.opencode/ssh/`、构建产物和依赖目录。
- Create: `src/index.ts` — 插件入口，默认导出 `{ id, server }`。
- Create: `src/plugin.ts` — 加载配置、创建 manager、注册工具和生命周期 hooks。
- Create: `src/config/types.ts` — 配置类型。
- Create: `src/config/loader.ts` — 读取全局和项目配置并追加合并。
- Create: `src/config/schema.ts` — 运行时配置校验。
- Create: `src/shared/errors.ts` — 错误码和错误格式化。
- Create: `src/shared/ids.ts` — command/session/connection ID 生成。
- Create: `src/history/store.ts` — 历史日志写入、读取、删除。
- Create: `src/history/formatter.ts` — XML 风格输出格式化。
- Create: `src/ssh/types.ts` — manager 内部状态类型。
- Create: `src/ssh/connection.ts` — `ssh2` 连接封装。
- Create: `src/ssh/manager.ts` — 连接池、命令、PTY、SFTP 和历史生命周期。
- Create: `src/tools/create-tools.ts` — 汇总工具注册。
- Create: `src/tools/ssh-list.ts` — `ssh_list`。
- Create: `src/tools/ssh-connect.ts` — `ssh_connect`。
- Create: `src/tools/ssh-exec.ts` — `ssh_exec`。
- Create: `src/tools/ssh-pty.ts` — `ssh_pty`。
- Create: `src/tools/ssh-history.ts` — `ssh_history`。
- Create: `src/tools/ssh-upload.ts` — `ssh_upload`。
- Create: `src/tools/ssh-download.ts` — `ssh_download`。
- Create: `src/tools/ssh-close.ts` — `ssh_close`。
- Create: `test/config.test.ts` — 配置加载/合并/校验测试。
- Create: `test/history.test.ts` — 历史写入、读取、清理测试。
- Create: `test/formatters.test.ts` — 输出格式测试。
- Create: `test/ssh2-compat.test.ts` — Bun 下 `ssh2` 最小兼容性测试。
- Create: `test/integration/openssh.test.ts` — Docker OpenSSH 集成测试。
- Create: `test/fixtures/openssh/` — Docker 测试 sshd 配置、密钥和脚本。
- Create: `README.md` — 使用、配置、安全说明。

## Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `.gitignore`
- Create: `README.md`

- [ ] **Step 1: Confirm goal and acceptance criteria**

Goal: 空项目具备 Bun/TypeScript 插件开发基础，能安装依赖、类型检查和构建。

Acceptance evidence:
- `bun install` exits 0
- `bun run typecheck` exits 0 after source files exist
- `bun run build` emits `dist/index.js`

- [ ] **Step 2: Create package metadata**

Create `package.json`:

```json
{
  "name": "opencode-ssh",
  "version": "0.1.0",
  "description": "OpenCode plugin that provides SSH tools for remote Linux operation.",
  "type": "module",
  "main": "dist/index.js",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "test:integration": "bun test test/integration",
    "prepack": "bun run build"
  },
  "dependencies": {
    "@opencode-ai/plugin": "latest",
    "@opencode-ai/sdk": "latest",
    "ssh2": "latest"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/ssh2": "latest",
    "typescript": "latest"
  },
  "engines": {
    "bun": ">=1.2.0"
  }
}
```

- [ ] **Step 3: Create TypeScript configs**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "types": ["bun-types"],
    "outDir": "dist",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "include": ["src/**/*.ts"],
  "exclude": ["test", "dist", ".tmp"]
}
```

- [ ] **Step 4: Create ignore rules and initial README**

Create `.gitignore`:

```gitignore
node_modules/
dist/
.tmp/
.opencode/ssh/
*.tsbuildinfo
.DS_Store
```

Create `README.md` with these sections:

```markdown
# opencode-ssh

OpenCode SSH plugin for remote Linux operations.

## Status

Initial development.

## Configuration

Global config: `~/.config/opencode/opencode-ssh.json`.
Project config: `<project>/opencode-ssh.json`.

Project hosts append to global hosts. Duplicate host `name` values are invalid.

## Security

Prefer `passwordEnv` and `privateKeyPassphraseEnv` over plaintext credentials.
History output is written to `.opencode/ssh/` by default and removed by `ssh_close` when cleanup is enabled.
```

- [ ] **Step 5: Run targeted verification**

Run: `bun install`

Expected: command exits 0 and creates `bun.lock`.

- [ ] **Step 6: Commit**

Only commit if the user has explicitly authorized commits in the current session.

```bash
git add package.json tsconfig.json tsconfig.build.json .gitignore README.md bun.lock
git commit -m "chore: scaffold opencode ssh plugin"
```

## Task 2: Plugin entry and tool registration skeleton

**Files:**
- Create: `src/index.ts`
- Create: `src/plugin.ts`
- Create: `src/tools/create-tools.ts`
- Create: `src/tools/ssh-list.ts`
- Create: `src/tools/ssh-connect.ts`
- Create: `src/tools/ssh-exec.ts`
- Create: `src/tools/ssh-pty.ts`
- Create: `src/tools/ssh-history.ts`
- Create: `src/tools/ssh-upload.ts`
- Create: `src/tools/ssh-download.ts`
- Create: `src/tools/ssh-close.ts`

- [ ] **Step 1: Confirm goal and acceptance criteria**

Goal: opencode 能加载插件入口，并看到八个 SSH 工具名。

Acceptance evidence:
- `bun run typecheck` passes
- `bun run build` passes
- Tool factory returns keys: `ssh_list`, `ssh_connect`, `ssh_exec`, `ssh_pty`, `ssh_history`, `ssh_upload`, `ssh_download`, `ssh_close`

- [ ] **Step 2: Create plugin entry**

Create `src/index.ts`:

```ts
import { createSSHPlugin } from "./plugin"

export default {
  id: "opencode-ssh",
  server: createSSHPlugin,
}
```

Create `src/plugin.ts`:

```ts
import type { Plugin } from "@opencode-ai/plugin"
import { createSSHTools } from "./tools/create-tools"

export const createSSHPlugin: Plugin = async (ctx) => {
  const manager = {
    async dispose() {},
  }

  await ctx.client.app.log({
    body: {
      service: "opencode-ssh",
      level: "info",
      message: "Plugin initialized",
    },
  })

  return {
    tool: createSSHTools(manager),
    dispose: async () => {
      await manager.dispose()
    },
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        await manager.dispose()
      }
    },
  }
}
```

- [ ] **Step 3: Create skeleton tools**

Create `src/tools/create-tools.ts`:

```ts
import { createSSHCloseTool } from "./ssh-close"
import { createSSHConnectTool } from "./ssh-connect"
import { createSSHDownloadTool } from "./ssh-download"
import { createSSHExecTool } from "./ssh-exec"
import { createSSHHistoryTool } from "./ssh-history"
import { createSSHListTool } from "./ssh-list"
import { createSSHPtyTool } from "./ssh-pty"
import { createSSHUploadTool } from "./ssh-upload"

export interface MinimalSSHManager {
  dispose(): Promise<void>
}

export function createSSHTools(manager: MinimalSSHManager) {
  return {
    ssh_list: createSSHListTool(manager),
    ssh_connect: createSSHConnectTool(manager),
    ssh_exec: createSSHExecTool(manager),
    ssh_pty: createSSHPtyTool(manager),
    ssh_history: createSSHHistoryTool(manager),
    ssh_upload: createSSHUploadTool(manager),
    ssh_download: createSSHDownloadTool(manager),
    ssh_close: createSSHCloseTool(manager),
  }
}
```

Create each `src/tools/ssh-*.ts` file with this pattern, changing title and description per tool:

```ts
import { tool } from "@opencode-ai/plugin"
import type { MinimalSSHManager } from "./create-tools"

export function createSSHListTool(_manager: MinimalSSHManager) {
  return tool({
    description: "List configured SSH hosts and active SSH sessions.",
    args: {},
    async execute() {
      return {
        title: "SSH hosts",
        output: "<ssh_hosts></ssh_hosts>",
      }
    },
  })
}
```

For `ssh-connect.ts`, export `createSSHConnectTool` and use description `Connect to a configured SSH host by name.`
For `ssh-exec.ts`, export `createSSHExecTool` and use description `Execute a remote SSH command in wait or background mode.`
For `ssh-pty.ts`, export `createSSHPtyTool` and use description `Operate an interactive SSH PTY session.`
For `ssh-history.ts`, export `createSSHHistoryTool` and use description `List or read SSH command history and output.`
For `ssh-upload.ts`, export `createSSHUploadTool` and use description `Upload a local file to a connected SSH host using SFTP.`
For `ssh-download.ts`, export `createSSHDownloadTool` and use description `Download a remote file from a connected SSH host using SFTP.`
For `ssh-close.ts`, export `createSSHCloseTool` and use description `Close SSH sessions and clean their history logs.`

- [ ] **Step 4: Run targeted verification**

Run: `bun run typecheck && bun run build`

Expected: both commands exit 0.

- [ ] **Step 5: Commit**

Only commit if explicitly authorized.

```bash
git add src package.json tsconfig.json tsconfig.build.json
git commit -m "feat: register ssh plugin tools"
```

## Task 3: Configuration loading and validation

**Files:**
- Create: `src/config/types.ts`
- Create: `src/config/schema.ts`
- Create: `src/config/loader.ts`
- Modify: `src/plugin.ts`
- Create: `test/config.test.ts`

- [ ] **Step 1: Confirm goal and acceptance criteria**

Goal: 全局和项目 `opencode-ssh.json` 能追加合并，重复 host name 报错，凭据优先级清晰。

Acceptance evidence:
- `bun test test/config.test.ts` passes
- Tests cover global-only, project-only, appended configs, duplicate names, missing auth, history defaults

- [ ] **Step 2: Define config types**

Create `src/config/types.ts`:

```ts
export interface SSHHostConfig {
  name: string
  host: string
  port: number
  username: string
  description?: string
  password?: string
  passwordEnv?: string
  privateKeyPath?: string
  privateKeyPassphrase?: string
  privateKeyPassphraseEnv?: string
  hostKey?: {
    mode: "accept-new" | "strict"
    fingerprint?: string
  }
}

export interface SSHHistoryConfig {
  enabled: boolean
  cleanupOnClose: boolean
}

export interface SSHPluginConfig {
  hosts: SSHHostConfig[]
  history: SSHHistoryConfig
}
```

- [ ] **Step 3: Implement validation**

Create `src/config/schema.ts`:

```ts
import type { SSHHostConfig, SSHPluginConfig } from "./types"

export function normalizeConfig(input: unknown, source: string): SSHPluginConfig {
  if (input === undefined || input === null) {
    return { hosts: [], history: { enabled: true, cleanupOnClose: true } }
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`CONFIG_INVALID: ${source} must be a JSON object`)
  }

  const raw = input as Record<string, unknown>
  const hosts = Array.isArray(raw.hosts) ? raw.hosts.map((host, index) => normalizeHost(host, `${source}.hosts[${index}]`)) : []
  const historyRaw = typeof raw.history === "object" && raw.history !== null ? (raw.history as Record<string, unknown>) : {}

  return {
    hosts,
    history: {
      enabled: typeof historyRaw.enabled === "boolean" ? historyRaw.enabled : true,
      cleanupOnClose: typeof historyRaw.cleanupOnClose === "boolean" ? historyRaw.cleanupOnClose : true,
    },
  }
}

function normalizeHost(input: unknown, source: string): SSHHostConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`CONFIG_INVALID: ${source} must be an object`)
  }
  const raw = input as Record<string, unknown>
  const name = readRequiredString(raw, "name", source)
  const host = readRequiredString(raw, "host", source)
  const username = readRequiredString(raw, "username", source)
  const config: SSHHostConfig = {
    name,
    host,
    username,
    port: typeof raw.port === "number" ? raw.port : 22,
    description: readOptionalString(raw, "description"),
    password: readOptionalString(raw, "password"),
    passwordEnv: readOptionalString(raw, "passwordEnv"),
    privateKeyPath: readOptionalString(raw, "privateKeyPath"),
    privateKeyPassphrase: readOptionalString(raw, "privateKeyPassphrase"),
    privateKeyPassphraseEnv: readOptionalString(raw, "privateKeyPassphraseEnv"),
  }
  if (!config.password && !config.passwordEnv && !config.privateKeyPath) {
    throw new Error(`AUTH_MISSING: ${source} must provide password, passwordEnv, or privateKeyPath`)
  }
  return config
}

function readRequiredString(raw: Record<string, unknown>, key: string, source: string): string {
  const value = raw[key]
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`CONFIG_INVALID: ${source}.${key} must be a non-empty string`)
  }
  return value
}

function readOptionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}
```

- [ ] **Step 4: Implement loader**

Create `src/config/loader.ts`:

```ts
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { normalizeConfig } from "./schema"
import type { SSHPluginConfig } from "./types"

export function loadConfig(projectDirectory: string): SSHPluginConfig {
  const globalPath = join(homedir(), ".config", "opencode", "opencode-ssh.json")
  const projectPath = join(projectDirectory, "opencode-ssh.json")
  const globalConfig = readConfigFile(globalPath)
  const projectConfig = readConfigFile(projectPath)
  return mergeConfigs(normalizeConfig(globalConfig, globalPath), normalizeConfig(projectConfig, projectPath))
}

function readConfigFile(path: string): unknown {
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, "utf8"))
}

export function mergeConfigs(globalConfig: SSHPluginConfig, projectConfig: SSHPluginConfig): SSHPluginConfig {
  const hosts = [...globalConfig.hosts, ...projectConfig.hosts]
  const seen = new Set<string>()
  for (const host of hosts) {
    if (seen.has(host.name)) {
      throw new Error(`HOST_DUPLICATE: duplicate SSH host name ${host.name}`)
    }
    seen.add(host.name)
  }
  return {
    hosts,
    history: projectConfig.history ?? globalConfig.history,
  }
}
```

- [ ] **Step 5: Add tests**

Create `test/config.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { mergeConfigs } from "../src/config/loader"
import { normalizeConfig } from "../src/config/schema"

describe("config", () => {
  test("normalizes defaults", () => {
    const config = normalizeConfig(undefined, "missing")
    expect(config.hosts).toEqual([])
    expect(config.history).toEqual({ enabled: true, cleanupOnClose: true })
  })

  test("appends global and project hosts", () => {
    const globalConfig = normalizeConfig({ hosts: [{ name: "global", host: "10.0.0.1", username: "root", password: "x" }] }, "global")
    const projectConfig = normalizeConfig({ hosts: [{ name: "project", host: "10.0.0.2", username: "root", passwordEnv: "P" }] }, "project")
    const merged = mergeConfigs(globalConfig, projectConfig)
    expect(merged.hosts.map((host) => host.name)).toEqual(["global", "project"])
  })

  test("rejects duplicate host names", () => {
    const one = normalizeConfig({ hosts: [{ name: "prod", host: "10.0.0.1", username: "root", password: "x" }] }, "one")
    const two = normalizeConfig({ hosts: [{ name: "prod", host: "10.0.0.2", username: "root", password: "y" }] }, "two")
    expect(() => mergeConfigs(one, two)).toThrow("HOST_DUPLICATE")
  })

  test("rejects hosts without auth", () => {
    expect(() => normalizeConfig({ hosts: [{ name: "prod", host: "10.0.0.1", username: "root" }] }, "config")).toThrow("AUTH_MISSING")
  })
})
```

- [ ] **Step 6: Run targeted verification**

Run: `bun test test/config.test.ts && bun run typecheck`

Expected: both commands exit 0.

- [ ] **Step 7: Commit**

Only commit if explicitly authorized.

```bash
git add src/config test/config.test.ts src/plugin.ts
git commit -m "feat: load ssh host configuration"
```

## Task 4: History store and output formatting

**Files:**
- Create: `src/shared/errors.ts`
- Create: `src/shared/ids.ts`
- Create: `src/history/store.ts`
- Create: `src/history/formatter.ts`
- Create: `test/history.test.ts`
- Create: `test/formatters.test.ts`

- [ ] **Step 1: Confirm goal and acceptance criteria**

Goal: 命令输出可以写入 `.opencode/ssh/<hostName>/<connectionId>/`、分页读取，并在 close 时清理。

Acceptance evidence:
- `bun test test/history.test.ts test/formatters.test.ts` passes
- Tests verify `history.enabled` and `cleanupOnClose` semantics

- [ ] **Step 2: Implement IDs and error formatting**

Create `src/shared/ids.ts`:

```ts
export function createId(prefix: string): string {
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 12)
  return `${prefix}_${Date.now().toString(36)}_${random}`
}
```

Create `src/shared/errors.ts`:

```ts
export function formatSSHError(code: string, hostName: string | undefined, message: string): string {
  const host = hostName ? ` host="${escapeXml(hostName)}"` : ""
  return `<ssh_error code="${escapeXml(code)}"${host}>\n${escapeXml(message)}\n</ssh_error>`
}

export function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}
```

- [ ] **Step 3: Implement formatter**

Create `src/history/formatter.ts`:

```ts
import { escapeXml } from "../shared/errors"

export interface OutputPage {
  id: string
  hostName: string
  status: string
  lines: string[]
  startLine: number
  hasMore: boolean
}

export function formatSSHOutput(page: OutputPage): string {
  const body = page.lines
    .map((line, index) => `${String(page.startLine + index).padStart(5, "0")}| ${escapeXml(truncateLine(line))}`)
    .join("\n")
  const more = page.hasMore ? "\n<ssh_more>true</ssh_more>" : ""
  return `<ssh_output id="${escapeXml(page.id)}" host="${escapeXml(page.hostName)}" status="${escapeXml(page.status)}">\n${body}${more}\n</ssh_output>`
}

function truncateLine(line: string): string {
  return line.length > 2000 ? `${line.slice(0, 2000)}…[truncated]` : line
}
```

- [ ] **Step 4: Implement history store**

Create `src/history/store.ts`:

```ts
import { mkdirSync, readFileSync, rmSync, appendFileSync } from "node:fs"
import { join } from "node:path"

export interface HistoryStoreOptions {
  projectDirectory: string
  enabled: boolean
  cleanupOnClose: boolean
}

export class HistoryStore {
  constructor(private readonly options: HistoryStoreOptions) {}

  pathFor(hostName: string, connectionId: string): string {
    return join(this.options.projectDirectory, ".opencode", "ssh", hostName, connectionId)
  }

  append(hostName: string, connectionId: string, recordId: string, chunk: string): void {
    if (!this.options.enabled) return
    const directory = this.pathFor(hostName, connectionId)
    mkdirSync(directory, { recursive: true })
    const date = new Date().toISOString().slice(0, 10)
    appendFileSync(join(directory, `${date}.log`), `[${recordId}] ${chunk}`)
  }

  read(hostName: string, connectionId: string): string {
    const date = new Date().toISOString().slice(0, 10)
    return readFileSync(join(this.pathFor(hostName, connectionId), `${date}.log`), "utf8")
  }

  cleanup(hostName: string, connectionId: string): void {
    if (!this.options.cleanupOnClose) return
    rmSync(this.pathFor(hostName, connectionId), { recursive: true, force: true })
  }
}
```

- [ ] **Step 5: Add tests**

Create `test/history.test.ts` using `.tmp/history-test` as root; assert append/read works, disabled history does not create logs, cleanup removes connection directory, cleanup disabled keeps logs.

Create `test/formatters.test.ts` and assert `formatSSHOutput({ id: "cmd_1", hostName: "prod", status: "running", lines: ["a", "b"], startLine: 1, hasMore: false })` contains `<ssh_output`, `00001| a`, and `00002| b`.

- [ ] **Step 6: Run targeted verification**

Run: `bun test test/history.test.ts test/formatters.test.ts && bun run typecheck`

Expected: both commands exit 0.

- [ ] **Step 7: Commit**

Only commit if explicitly authorized.

```bash
git add src/shared src/history test/history.test.ts test/formatters.test.ts
git commit -m "feat: add ssh history store"
```

## Task 5: SSH2 compatibility spike

**Files:**
- Create: `test/ssh2-compat.test.ts`
- Create: `test/fixtures/openssh/Dockerfile`
- Create: `test/fixtures/openssh/sshd_config`
- Create: `test/fixtures/openssh/start.sh`

- [ ] **Step 1: Confirm goal and acceptance criteria**

Goal: 在继续封装 manager 前证明 Bun 可以安装、导入并使用 `ssh2` 完成基本连接、exec、PTY 和 SFTP。

Acceptance evidence:
- `bun test test/ssh2-compat.test.ts` passes against Docker OpenSSH server
- If it fails because `ssh2` is incompatible with Bun, stop and report the failure before implementing manager

- [ ] **Step 2: Create OpenSSH fixture**

Create `test/fixtures/openssh/Dockerfile`:

```Dockerfile
FROM alpine:3.20
RUN apk add --no-cache openssh-server bash sudo
RUN adduser -D -s /bin/bash testuser && echo 'testuser:testpass' | chpasswd
RUN mkdir -p /var/run/sshd /home/testuser/upload && chown -R testuser:testuser /home/testuser
COPY sshd_config /etc/ssh/sshd_config
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 2222
CMD ["/start.sh"]
```

Create `test/fixtures/openssh/sshd_config`:

```text
Port 2222
ListenAddress 0.0.0.0
PasswordAuthentication yes
PermitRootLogin no
PermitEmptyPasswords no
UsePAM no
Subsystem sftp internal-sftp
```

Create `test/fixtures/openssh/start.sh`:

```sh
#!/bin/sh
ssh-keygen -A
exec /usr/sbin/sshd -D -e
```

- [ ] **Step 3: Add compatibility test**

Create `test/ssh2-compat.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { Client } from "ssh2"

describe("ssh2 compatibility", () => {
  test("imports ssh2 client", () => {
    expect(typeof Client).toBe("function")
  })
})
```

After the Docker fixture is available, expand this file to connect to `127.0.0.1:<mapped port>` with username `testuser` and password `testpass`, run `echo ok`, open `shell()`, and call `sftp().fastPut/fastGet`.

- [ ] **Step 4: Run targeted verification**

Run: `bun test test/ssh2-compat.test.ts`

Expected: import test passes. Full Docker-backed compatibility must pass before Task 7 starts.

- [ ] **Step 5: Commit**

Only commit if explicitly authorized.

```bash
git add test/ssh2-compat.test.ts test/fixtures/openssh
git commit -m "test: verify ssh2 compatibility"
```

## Task 6: Connection wrapper and manager state model

**Files:**
- Create: `src/ssh/types.ts`
- Create: `src/ssh/connection.ts`
- Create: `src/ssh/manager.ts`
- Modify: `src/plugin.ts`

- [ ] **Step 1: Confirm goal and acceptance criteria**

Goal: manager 可以按 host name 建立、列出、关闭连接，并持有 history store。

Acceptance evidence:
- `bun run typecheck` passes
- Unit tests or integration tests can instantiate manager with config and close all sessions

- [ ] **Step 2: Define SSH state types**

Create `src/ssh/types.ts`:

```ts
import type { Client } from "ssh2"
import type { SSHHostConfig, SSHPluginConfig } from "../config/types"

export interface SSHConnectionState {
  id: string
  host: SSHHostConfig
  client: Client
  status: "connecting" | "connected" | "closed" | "failed"
  createdAt: Date
  lastError?: string
}

export interface SSHCommandRecord {
  id: string
  hostName: string
  connectionId: string
  command: string
  status: "running" | "completed" | "failed" | "timeout" | "cancelled"
  stdout: string[]
  stderr: string[]
  exitCode: number | null
  startedAt: Date
  completedAt?: Date
}

export interface SSHManagerOptions {
  projectDirectory: string
  config: SSHPluginConfig
}
```

- [ ] **Step 3: Implement connection wrapper**

Create `src/ssh/connection.ts` with `connectHost(host, signal)` that resolves on `ready`, rejects on `error`, reads private key from `privateKeyPath` when provided, resolves `passwordEnv` and `privateKeyPassphraseEnv` from `process.env`, and calls `client.end()` on abort.

- [ ] **Step 4: Implement manager shell**

Create `src/ssh/manager.ts` with methods:

```ts
export class SSHManager {
  listHosts(): Array<{ name: string; host: string; username: string; connected: boolean; description?: string }>
  connect(hostName: string, signal?: AbortSignal): Promise<SSHConnectionState>
  getConnection(hostName: string): SSHConnectionState
  async close(hostName?: string): Promise<void>
  async dispose(): Promise<void>
}
```

`close(hostName)` closes one host and calls history cleanup for each connection. `close()` with no host closes all.

- [ ] **Step 5: Wire plugin to real manager**

Modify `src/plugin.ts` so initialization calls `loadConfig(ctx.directory)`, creates `new SSHManager({ projectDirectory: ctx.directory, config })`, and `dispose` calls `manager.dispose()`.

- [ ] **Step 6: Run targeted verification**

Run: `bun run typecheck`

Expected: exits 0.

- [ ] **Step 7: Commit**

Only commit if explicitly authorized.

```bash
git add src/ssh src/plugin.ts
git commit -m "feat: manage ssh connections"
```

## Task 7: Implement ssh_list and ssh_connect

**Files:**
- Modify: `src/tools/ssh-list.ts`
- Modify: `src/tools/ssh-connect.ts`
- Modify: `src/tools/create-tools.ts`

- [ ] **Step 1: Confirm goal and acceptance criteria**

Goal: 模型可查看主机并主动连接。

Acceptance evidence:
- `ssh_list` never prints secrets
- `ssh_connect` returns `<ssh_connected>` on success and `<ssh_error>` on failure

- [ ] **Step 2: Implement ssh_list**

`ssh_list` should call `manager.listHosts()` and return XML containing only `name`, `host`, `user`, `connected`, and description.

- [ ] **Step 3: Implement ssh_connect**

`ssh_connect` args:

```ts
{
  hostName: tool.schema.string().describe("Configured SSH host name."),
  timeoutSeconds: tool.schema.number().int().positive().max(120).optional().describe("Connection timeout in seconds."),
}
```

Use `context.abort` and timeout handling. Return `title: "SSH connected"` and metadata `{ hostName, connectionId }`.

- [ ] **Step 4: Run targeted verification**

Run: `bun run typecheck`

Expected: exits 0.

- [ ] **Step 5: Commit**

Only commit if explicitly authorized.

```bash
git add src/tools/ssh-list.ts src/tools/ssh-connect.ts src/tools/create-tools.ts
git commit -m "feat: list and connect ssh hosts"
```

## Task 8: Implement ssh_exec wait and background modes

**Files:**
- Modify: `src/ssh/manager.ts`
- Modify: `src/tools/ssh-exec.ts`
- Modify: `src/history/store.ts`

- [ ] **Step 1: Confirm goal and acceptance criteria**

Goal: 普通命令支持等待完成和后台执行，输出可通过历史检索。

Acceptance evidence:
- `ssh_exec mode=wait` returns stdout/stderr/exitCode
- `ssh_exec mode=background` returns commandId immediately
- Background output is appended to history

- [ ] **Step 2: Add manager exec methods**

Add:

```ts
execWait(hostName: string, command: string, options: { timeoutSeconds?: number; cwd?: string; env?: Record<string, string>; abort?: AbortSignal }): Promise<SSHCommandRecord>
execBackground(hostName: string, command: string, options: { timeoutSeconds?: number; cwd?: string; env?: Record<string, string>; abort?: AbortSignal }): Promise<SSHCommandRecord>
```

Use `client.exec(command, options, callback)` and collect stdout/stderr chunks. On close, set `exitCode`, status, `completedAt`, and append output to history.

- [ ] **Step 3: Implement ssh_exec tool**

Args:

```ts
{
  hostName: tool.schema.string(),
  command: tool.schema.string(),
  mode: tool.schema.enum(["wait", "background"]).default("wait"),
  timeoutSeconds: tool.schema.number().int().positive().max(86400).optional(),
  cwd: tool.schema.string().optional(),
  env: tool.schema.record(tool.schema.string()).optional(),
}
```

For `cwd`, execute `cd <quoted cwd> && <command>` only after adding a small shell quoting helper. If no safe quoting helper exists yet, omit `cwd` support from execution and return `CONFIG_INVALID` for `cwd` until the helper is implemented.

- [ ] **Step 4: Run targeted verification**

Run: `bun run typecheck`

Expected: exits 0.

- [ ] **Step 5: Commit**

Only commit if explicitly authorized.

```bash
git add src/ssh/manager.ts src/tools/ssh-exec.ts src/history/store.ts
git commit -m "feat: execute ssh commands"
```

## Task 9: Implement ssh_history retrieval

**Files:**
- Modify: `src/ssh/manager.ts`
- Modify: `src/tools/ssh-history.ts`
- Modify: `src/history/formatter.ts`

- [ ] **Step 1: Confirm goal and acceptance criteria**

Goal: 模型可以列出历史记录并分页读取指定命令或 PTY 输出。

Acceptance evidence:
- `ssh_history action=list` returns record IDs and statuses
- `ssh_history action=read` returns `<ssh_output>` with line numbers
- Closed connection with cleanup enabled returns `HISTORY_NOT_FOUND`

- [ ] **Step 2: Add manager history methods**

Add:

```ts
listHistory(hostName?: string): SSHCommandRecord[]
readHistory(input: { id: string; offset: number; limit: number; pattern?: string; ignoreCase?: boolean }): OutputPage
```

- [ ] **Step 3: Implement ssh_history tool**

Args:

```ts
{
  action: tool.schema.enum(["list", "read"]),
  hostName: tool.schema.string().optional(),
  id: tool.schema.string().optional(),
  offset: tool.schema.number().int().min(1).default(1),
  limit: tool.schema.number().int().min(1).max(500).default(100),
  pattern: tool.schema.string().optional(),
  ignoreCase: tool.schema.boolean().default(false),
}
```

If `action=read` and `id` is missing, return `CONFIG_INVALID`.

- [ ] **Step 4: Run targeted verification**

Run: `bun run typecheck && bun test test/history.test.ts test/formatters.test.ts`

Expected: exits 0.

- [ ] **Step 5: Commit**

Only commit if explicitly authorized.

```bash
git add src/ssh/manager.ts src/tools/ssh-history.ts src/history/formatter.ts test
git commit -m "feat: read ssh command history"
```

## Task 10: Implement ssh_pty interactive sessions

**Files:**
- Modify: `src/ssh/types.ts`
- Modify: `src/ssh/manager.ts`
- Modify: `src/tools/ssh-pty.ts`

- [ ] **Step 1: Confirm goal and acceptance criteria**

Goal: 需要交互的远程命令可以启动 PTY、写入原始输入、读取输出、resize 和 kill。

Acceptance evidence:
- PTY start returns ptySessionId
- PTY write supports `\n`, `\x03`, `\x04`
- PTY read returns line-numbered output

- [ ] **Step 2: Add PTY state and manager methods**

Add `SSHPtySession` with `id`, `hostName`, `connectionId`, `status`, `buffer`, `startedAt`, `completedAt`.

Add manager methods:

```ts
ptyStart(hostName: string, options: { command?: string; cols?: number; rows?: number }): Promise<SSHPtySession>
ptyWrite(id: string, data: string): Promise<void>
ptyRead(id: string, offset: number, limit: number): OutputPage
ptyResize(id: string, cols: number, rows: number): Promise<void>
ptyKill(id: string): Promise<void>
```

- [ ] **Step 3: Implement control sequence decoding**

Implement helper that converts literal sequences `\n`, `\r`, `\t`, `\xNN`, `\uNNNN` to real bytes before writing to the channel.

- [ ] **Step 4: Implement ssh_pty tool**

Args:

```ts
{
  action: tool.schema.enum(["start", "write", "read", "resize", "kill"]),
  hostName: tool.schema.string().optional(),
  ptySessionId: tool.schema.string().optional(),
  command: tool.schema.string().optional(),
  data: tool.schema.string().optional(),
  cols: tool.schema.number().int().min(20).max(300).default(120),
  rows: tool.schema.number().int().min(5).max(100).default(30),
  offset: tool.schema.number().int().min(1).default(1),
  limit: tool.schema.number().int().min(1).max(500).default(100),
}
```

Validate required fields per action.

- [ ] **Step 5: Run targeted verification**

Run: `bun run typecheck`

Expected: exits 0.

- [ ] **Step 6: Commit**

Only commit if explicitly authorized.

```bash
git add src/ssh src/tools/ssh-pty.ts
git commit -m "feat: support interactive ssh pty"
```

## Task 11: Implement SFTP upload and download

**Files:**
- Modify: `src/ssh/manager.ts`
- Modify: `src/tools/ssh-upload.ts`
- Modify: `src/tools/ssh-download.ts`

- [ ] **Step 1: Confirm goal and acceptance criteria**

Goal: 已连接主机支持单文件 SFTP 上传和下载。

Acceptance evidence:
- Upload copies local file to remote path
- Download copies remote file to local path
- Permission or missing-file errors return `<ssh_error>`

- [ ] **Step 2: Add manager SFTP methods**

Add:

```ts
upload(hostName: string, localPath: string, remotePath: string): Promise<void>
download(hostName: string, remotePath: string, localPath: string): Promise<void>
```

Use `client.sftp()` and `fastPut` / `fastGet`.

- [ ] **Step 3: Implement upload/download tools**

`ssh_upload` args: `hostName`, `localPath`, `remotePath`.

`ssh_download` args: `hostName`, `remotePath`, `localPath`.

Return `<ssh_transfer direction="upload" status="completed">` or `<ssh_transfer direction="download" status="completed">`.

- [ ] **Step 4: Run targeted verification**

Run: `bun run typecheck`

Expected: exits 0.

- [ ] **Step 5: Commit**

Only commit if explicitly authorized.

```bash
git add src/ssh/manager.ts src/tools/ssh-upload.ts src/tools/ssh-download.ts
git commit -m "feat: transfer files over sftp"
```

## Task 12: Implement ssh_close cleanup

**Files:**
- Modify: `src/ssh/manager.ts`
- Modify: `src/tools/ssh-close.ts`
- Modify: `src/plugin.ts`

- [ ] **Step 1: Confirm goal and acceptance criteria**

Goal: 关闭连接会终止后台命令、PTY、SFTP、SSH connection，并按配置清理日志。

Acceptance evidence:
- `ssh_close` one host closes only that host
- `ssh_close` without host closes all hosts
- `history.cleanupOnClose: true` removes logs

- [ ] **Step 2: Implement close semantics**

Ensure `SSHManager.close(hostName?)` iterates matching connections, kills running command channels, kills PTY channels, calls `client.end()`, marks records cancelled or closed, and calls `historyStore.cleanup(hostName, connectionId)`.

- [ ] **Step 3: Implement ssh_close tool**

Args:

```ts
{
  hostName: tool.schema.string().optional().describe("Configured host name. Omit to close all SSH connections."),
}
```

Return `<ssh_closed host="prod-api">` or `<ssh_closed host="all">`.

- [ ] **Step 4: Run targeted verification**

Run: `bun run typecheck && bun test test/history.test.ts`

Expected: exits 0.

- [ ] **Step 5: Commit**

Only commit if explicitly authorized.

```bash
git add src/ssh/manager.ts src/tools/ssh-close.ts src/plugin.ts
git commit -m "feat: close ssh sessions cleanly"
```

## Task 13: Docker OpenSSH integration tests

**Files:**
- Modify: `test/integration/openssh.test.ts`
- Modify: `test/fixtures/openssh/*`

- [ ] **Step 1: Confirm goal and acceptance criteria**

Goal: 用真实 Docker OpenSSH server 验证核心工具行为，禁止用 mock 代替集成测试。

Acceptance evidence:
- `bun run test:integration` passes
- Tests cover connect, exec wait, exec background/history, PTY, upload, download, close cleanup

- [ ] **Step 2: Implement test harness**

Use `Bun.spawn` to run Docker commands. All temporary files and generated keys go under `.tmp/openssh-test/`.

Required lifecycle:

1. Build image from `test/fixtures/openssh`.
2. Run container with mapped port.
3. Write project `opencode-ssh.json` in `.tmp/openssh-test/project/`.
4. Instantiate manager directly with that project directory.
5. Stop and remove container in `afterAll`.

- [ ] **Step 3: Add behavior tests**

Add tests:

- `connects to configured host`
- `executes wait command and returns exit code 0`
- `records background command output and reads it through history`
- `starts pty shell, writes echo command, reads output`
- `uploads and downloads one file with sftp`
- `close removes connection logs when cleanupOnClose is true`

- [ ] **Step 4: Run targeted verification**

Run: `bun run test:integration`

Expected: exits 0 with Docker available.

- [ ] **Step 5: Commit**

Only commit if explicitly authorized.

```bash
git add test/integration test/fixtures/openssh
git commit -m "test: cover ssh plugin integration"
```

## Task 14: Documentation and final verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-05-27-opencode-ssh-plugin-design.md` only if implementation changes require spec corrections

- [ ] **Step 1: Confirm goal and acceptance criteria**

Goal: README explains install, opencode config, SSH config, credentials, tools, history behavior, cleanup, and security risks.

Acceptance evidence:
- README includes global/project config paths
- README documents all tools
- README documents `history.enabled` and `history.cleanupOnClose`
- README documents official docs references and `ctx7` commands used

- [ ] **Step 2: Update README**

Include these sections:

- Install
- Load plugin from npm
- Load plugin from local path
- SSH config file schema
- Credential security
- Tool list
- History and cleanup behavior
- Testing
- Official documentation references

- [ ] **Step 3: Run full verification**

Run:

```bash
bun run typecheck
bun test
bun run build
bun run test:integration
```

Expected: every command exits 0. If Docker is unavailable, state the exact Docker error and do not claim integration tests passed.

- [ ] **Step 4: Final status check**

Run:

```bash
git status --short
git diff
```

Expected: only intended files are changed.

- [ ] **Step 5: Commit**

Only commit if explicitly authorized.

```bash
git add README.md docs/superpowers/specs/2026-05-27-opencode-ssh-plugin-design.md
git commit -m "docs: document ssh plugin usage"
```

## Self-review checklist

- Spec coverage:
  - Config loading and append merge: Task 3.
  - Duplicate host rejection: Task 3.
  - Plugin default export shape: Task 2.
  - `ssh_list` / `ssh_connect`: Task 7.
  - `ssh_exec` wait/background: Task 8.
  - `ssh_history` retrieval and config semantics: Task 9.
  - `ssh_pty`: Task 10.
  - Upload/download: Task 11.
  - `ssh_close` cleanup: Task 12.
  - Docker integration: Task 13.
  - README/security docs: Task 14.
- Placeholder scan requirement: before handoff, search this file for unfinished placeholder language and remove every match.
- Type consistency: use `hostName`, `connectionId`, `commandId`, `ptySessionId`, `history.enabled`, and `history.cleanupOnClose` consistently across files.
