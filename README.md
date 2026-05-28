# opencode-ssh

[English](./README.md) · [简体中文](./README.zh-CN.md)

> An [opencode](https://opencode.ai) plugin that gives the AI eight controlled SSH tools to operate remote Linux hosts: list, connect, exec, PTY, history, upload, download, close.

[![CI](https://github.com/Suknna/opencode-ssh/actions/workflows/ci.yml/badge.svg)](https://github.com/Suknna/opencode-ssh/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/opencode-ssh.svg)](https://www.npmjs.com/package/opencode-ssh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## What this plugin does for opencode

opencode is an AI-driven coding agent. By default it cannot SSH into remote machines. This plugin registers eight tools through opencode's official plugin API so the model can:

- **List** which hosts are configured (`ssh_list`).
- **Open** a connection on demand (`ssh_connect`) — nothing connects automatically at startup.
- **Execute** remote commands in foreground or background (`ssh_exec`).
- **Drive** an interactive PTY shell for commands that need a terminal, like `sudo`, `passwd`, `apt -y` (`ssh_pty`).
- **Inspect** previous command output through a paginated history (`ssh_history`).
- **Transfer** single files via SFTP (`ssh_upload`, `ssh_download`).
- **Close** connections and clean up local logs (`ssh_close`).

Under the hood it uses the [`ssh2`](https://github.com/mscdex/ssh2) library, supports both password and private-key auth (with environment-variable references), and writes per-command output to `.opencode/ssh/` inside your project so the model can review long-running output later.

## Quick start (5 minutes)

### 1. Install opencode

If you don't have opencode yet:

```sh
curl -fsSL https://opencode.ai/install | bash
```

See [opencode docs](https://opencode.ai/docs/) for other install options. opencode runs on [Bun](https://bun.sh) `>=1.2.0`, which the installer takes care of.

### 2. Add the plugin to your project

Inside the project where you run opencode, install the plugin:

```sh
bun add opencode-ssh
```

Then add it to `opencode.json` at the project root (create the file if it doesn't exist):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-ssh"]
}
```

### 3. Configure one host

Create `opencode-ssh.json` in the project root with the simplest possible config — one host, password auth via an environment variable:

```json
{
  "hosts": [
    {
      "name": "dev",
      "host": "192.168.1.100",
      "username": "ubuntu",
      "description": "Local dev box",
      "passwordEnv": "DEV_SSH_PASSWORD"
    }
  ]
}
```

Export the password before starting opencode:

```sh
export DEV_SSH_PASSWORD='your-real-password'
```

### 4. Use it from opencode

Start opencode in the project. In your conversation, ask the model to use the SSH tools, for example:

> List my SSH hosts. Connect to `dev` and run `uname -a`.

The model will call `ssh_list`, then `ssh_connect`, then `ssh_exec`. You don't have to call the tools yourself — opencode handles the tool routing.

That's it for the quick start. Read on for security recommendations and the full configuration reference.

## Configuration reference

### Where the config lives

The plugin reads two independent JSON files at startup:

| Scope   | Path                                    |
| ------- | --------------------------------------- |
| Global  | `~/.config/opencode/opencode-ssh.json`  |
| Project | `<project-root>/opencode-ssh.json`      |

Either file may be absent. If both exist, the project file's `hosts` array is **appended** to the global file's hosts (project does not override global). Host `name` values must be unique across the merged result; duplicates fail with a `HOST_DUPLICATE` error and the plugin refuses to start.

`history` is taken from the project file when the project file explicitly defines a `history` object; otherwise the plugin falls back to the global `history`, then to the defaults `{ enabled: true, cleanupOnClose: true }`.

### Full host example

```json
{
  "hosts": [
    {
      "name": "prod-api",
      "host": "1.2.3.4",
      "port": 22,
      "username": "deploy",
      "description": "Production API server",
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

### Host fields

Required:

- `name` — unique identifier the model uses in every tool call.
- `host` — hostname or IP.
- `username` — remote user.

At least one credential is required: `password`, `passwordEnv`, or `privateKeyPath`. Otherwise the plugin throws `AUTH_MISSING` during config load.

Optional:

| Field                      | Type                                  | Notes                                                              |
| -------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `port`                     | integer                               | Defaults to `22`.                                                  |
| `description`              | string                                | Free-form text shown in `ssh_list` output.                         |
| `password`                 | string                                | Plaintext password. Use only for local experiments.                |
| `passwordEnv`              | string                                | Name of an env var holding the password. **Recommended.**          |
| `privateKeyPath`           | string                                | Absolute or `~/`-prefixed path to a key file.                      |
| `privateKeyPassphrase`     | string                                | Plaintext passphrase. Use only for local experiments.              |
| `privateKeyPassphraseEnv`  | string                                | Name of an env var holding the passphrase. **Recommended.**        |
| `hostKey.mode`             | `"accept-new"` \| `"strict"`          | See [Host key risk](#host-key-risk) below before using `"strict"`. |
| `hostKey.fingerprint`      | string                                | Reserved; full strict pinning is not yet enforced at runtime.      |

### Credential resolution

The connector resolves credentials per category, then passes everything `ssh2` understands to the underlying client:

- For passwords: if `passwordEnv` is set and the env var has a value, that wins; otherwise the literal `password` is used.
- For private-key passphrases: if `privateKeyPassphraseEnv` is set and the env var has a value, that wins; otherwise the literal `privateKeyPassphrase` is used.
- If `privateKeyPath` is configured, the key file is read at connect time.

`ssh2` may try **multiple authentication methods in one connection**, so configuring both a private key and a password is allowed and the remote SSH server decides which method to accept. There is no strict "private-key wins over password" hierarchy in this plugin.

### History fields

```json
{
  "history": {
    "enabled": true,
    "cleanupOnClose": true
  }
}
```

Both fields default to `true`. See [History and cleanup behavior](#history-and-cleanup-behavior).

## Tools the model can call

All eight tools come from `src/tools/create-tools.ts` and use Zod-typed argument schemas. The model picks them by name; you don't call them directly.

| Tool            | What it does                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ssh_list`      | List configured hosts and current connection state.                                                                           |
| `ssh_connect`   | Open a connection to one host. Required before any other host operation.                                                      |
| `ssh_exec`      | Run a remote command in `wait` (blocking) or `background` mode. Returns `commandId`, `stdout`, `stderr`, `exitCode`, `status`. |
| `ssh_pty`       | Open and drive an interactive PTY session for `sudo`, `passwd`, REPLs, etc. Supports `start`, `write`, `read`, `resize`, `kill`. |
| `ssh_history`   | List previous commands and PTY sessions, or read paginated output by id. **Reads in-memory records of the current process.** |
| `ssh_upload`    | Upload a single local file to a connected host via SFTP.                                                                      |
| `ssh_download`  | Download a single remote file via SFTP.                                                                                       |
| `ssh_close`     | Close one host's connection (or all). Cancels background commands, kills PTY sessions, removes per-connection history when `cleanupOnClose: true`. |

### Notable input limits

- `ssh_connect.timeoutSeconds`: 1–120, default `30`.
- `ssh_exec.timeoutSeconds`: 1–86400.
- `ssh_exec.cwd` is currently rejected with `CONFIG_INVALID`. Pass the working directory inline with the command (`cd /tmp && do-thing`).
- `ssh_pty` `cols` 20–300, `rows` 5–100; `read` `limit` ≤ 500.
- `ssh_pty.write.data` accepts the escapes `\n`, `\r`, `\t`, `\xNN`, `\uNNNN`.
- `ssh_history` `limit` 1–500. The schema marks `id` as optional, but `action: "read"` returns `CONFIG_INVALID` when `id` is missing.
- The PTY in-memory buffer caps at ~1,000,000 characters per session; older data is discarded and `read` injects a `[pty output truncated: oldest data discarded]` line as the first row when truncation happened.

### Errors

Each tool returns a structured `<ssh_error>` block on failure. Error codes are whitelisted, e.g. `HOST_NOT_FOUND`, `CONNECT_TIMEOUT`, `CONNECT_FAILED`, `CONFIG_INVALID`, `COMMAND_FAILED`, `PTY_NOT_FOUND`, `PTY_FAILED`, `HISTORY_NOT_FOUND`, `TRANSFER_FAILED`, `CLOSE_FAILED`. Underlying error messages are sanitized so secrets don't leak through error output.

## History and cleanup behavior

### On-disk layout

When `history.enabled: true`, every command and PTY session writes a log file under:

```
<project>/.opencode/ssh/<hostName>/<connectionId>/<recordId>.log
```

`<recordId>` is the per-record id assigned at execution time (e.g., `cmd_xxx`, `pty_xxx`). One file per command/session keeps cleanup straightforward.

### Behavior matrix

| `history.enabled` | `history.cleanupOnClose` | Live connection                                                                                       | After `ssh_close`                                                                                                                       |
| :---------------: | :----------------------: | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `true` (default)  | `true` (default)         | `ssh_exec`/`ssh_pty` output is appended to disk and indexed in memory. `ssh_history` reads in-memory. | The connection's history directory `.opencode/ssh/<hostName>/<connectionId>/` is removed; in-memory records cleared.                    |
| `true`            | `false`                  | Same as above.                                                                                        | Disk logs are kept under `.opencode/ssh/...` for offline audit, but in-memory records are cleared, so `ssh_history` no longer sees them. |
| `false`           | any                      | Nothing is written to disk; `ssh_history` only sees the in-memory buffer.                             | In-memory state for the connection is dropped on close; previously buffered output is no longer retrievable.                            |

`opencode`'s `dispose` and `session.deleted` events run the same close path, so closing opencode or deleting a session also cleans up according to these rules.

### Privacy implications

Remote command output may contain secrets, file contents, or hostnames you don't want to keep around. The defaults preserve full output during the live connection so `ssh_history` works, then wipe it when the connection closes. For sensitive workflows, set `history.enabled: false`.

Add `.opencode/ssh/` to `.gitignore` (the repo's own `.gitignore` already does). **Do not commit `opencode-ssh.json` if it contains literal `password` or `privateKeyPassphrase` values.**

## Security recommendations

### Use environment variables for secrets

- Prefer `passwordEnv` and `privateKeyPassphraseEnv` for any shared, production, or CI configuration.
- Treat literal `password` / `privateKeyPassphrase` as strictly local-only, and add the config file to `.gitignore`.
- Even with env vars, avoid printing secrets via `export FOO=...` in shared shell history or CI logs. Use a secret manager or a gitignored `.envrc`.

### Host key risk

`hostKey.mode` defaults to `"accept-new"`. In that mode the SSH client trusts whatever host key the server presents on first contact. This is convenient for local development but exposes you to man-in-the-middle attacks on the first connection.

> **Heads-up**: setting `"hostKey.mode": "strict"` in the current build causes `ssh_connect` to fail immediately, because strict pinning at the plugin level is not implemented yet. Until strict pinning lands, use `"accept-new"` (or omit the field) and pin host keys at the SSH layer instead — for example with a managed `~/.ssh/known_hosts`.

### Do not commit

- `opencode-ssh.json` if it contains literal credentials.
- `.opencode/ssh/` (per-connection logs).
- `.tmp/` (test artifacts).

## Local development

```sh
git clone https://github.com/Suknna/opencode-ssh
cd opencode-ssh
bun install
bun run typecheck
bun test
bun run build
```

The integration suite runs a real OpenSSH container; it does not fall back to mocks:

```sh
bun run test:integration
```

You need a working Docker daemon (Docker Desktop, OrbStack, Colima, etc.). Without Docker the integration tests fail by design.

To use a local checkout from another project, add it to that project's `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./.opencode/plugins/opencode-ssh/dist/index.js"]
}
```

After running `bun run build`, `dist/index.js` exists at the path above (or wherever you place the built artifact).

## License

MIT — see [LICENSE](./LICENSE).

## References

- [opencode plugin API](https://opencode.ai/docs/plugins/)
- [opencode SDK](https://opencode.ai/docs/sdk/)
- [`ssh2` library](https://github.com/mscdex/ssh2)
