import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { loadConfig } from "../../src/config/loader.js";
import { SSHManager } from "../../src/ssh/manager.js";

const runId = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const testBaseRoot = join(process.cwd(), ".tmp", "openssh-test");
const testRoot = join(testBaseRoot, runId);
const projectDirectory = join(testRoot, "project");
const localDirectory = join(testRoot, "local");
const fixtureDirectory = join(process.cwd(), "test", "fixtures", "openssh");
const imageName = `opencode-ssh-openssh-test:${runId}`;
const containerName = `opencode-ssh-openssh-test-${runId}`;
const hostName = "openssh";
const sshUser = "testuser";
const sshPassword = "testpass";

let manager: SSHManager | undefined;
let mappedPort: number | undefined;

describe("OpenSSH integration", () => {
  beforeAll(async () => {
    try {
      await assertDockerAvailable();
      await rm(testRoot, { force: true, recursive: true });
      await mkdir(projectDirectory, { recursive: true });
      await mkdir(localDirectory, { recursive: true });

      await docker(["build", "--tag", imageName, fixtureDirectory], 120_000);
      await docker([
        "run",
        "--detach",
        "--name",
        containerName,
        "--label",
        "opencode-ssh-test=true",
        "--publish",
        "127.0.0.1::2222",
        imageName,
      ], 30_000);
      mappedPort = Number((await docker(["port", containerName, "2222/tcp"], 10_000)).split(":").at(-1));
      expect(Number.isInteger(mappedPort)).toBe(true);

      await writeProjectConfig(mappedPort);
      const config = await loadConfig(projectDirectory);
      manager = new SSHManager({ projectDirectory, config });
      await waitFor(async () => {
        try {
          await manager?.connect(hostName);
          return true;
        } catch {
          return undefined;
        }
      }, "OpenSSH container readiness", 20_000);
    } catch (error) {
      await cleanup();
      throw error;
    }
  });

  afterAll(async () => {
    await cleanup();
  });

  test("connects to configured host", async () => {
    const ssh = getManager();
    const port = getMappedPort();

    const state = await ssh.connect(hostName);

    expect(state.status).toBe("connected");
    expect(state.host.host).toBe("127.0.0.1");
    expect(state.host.port).toBe(port);
    expect(state.host.username).toBe(sshUser);
  });

  test("executes wait command and returns exit code 0", async () => {
    const ssh = getManager();
    await ssh.connect(hostName);

    const foreground = await ssh.execWait(hostName, "echo ok", { timeoutSeconds: 10 });

    expect(foreground.status).toBe("completed");
    expect(foreground.exitCode).toBe(0);
    expect(foreground.stdout).toBe("ok\n");
  });

  test("records background command output and reads it through history", async () => {
    const ssh = getManager();
    await ssh.connect(hostName);

    const background = await ssh.execBackground(hostName, "printf 'background-ok\\n'", { timeoutSeconds: 10 });
    await waitFor(() => background.status === "completed", "background command to complete");

    const history = ssh.readHistory({ id: background.id, offset: 1, limit: 10 });
    expect(history.status).toBe("completed");
    expect(history.lines).toContain("background-ok");
  });

  test("starts a pty and reads command output", async () => {
    const ssh = getManager();
    await ssh.connect(hostName);

    const pty = await ssh.ptyStart(hostName, { rows: 24, cols: 80 });
    ssh.ptyWrite(pty.id, "echo pty-ok\n");

    const page = await waitFor(() => {
      const output = ssh.ptyRead(pty.id, 1, 100);
      return output.lines.some((line) => line.includes("pty-ok")) ? output : undefined;
    }, "pty output");

    expect(page.lines.some((line) => line.includes("pty-ok"))).toBe(true);
    ssh.ptyKill(pty.id);
  });

  test("uploads and downloads a single file", async () => {
    const ssh = getManager();
    await ssh.connect(hostName);
    const localSource = join(localDirectory, "upload.txt");
    const localDownload = join(localDirectory, "download.txt");
    const remotePath = `/home/${sshUser}/upload/opencode-ssh-upload-${runId}.txt`;

    await writeFile(localSource, "sftp-ok\n", "utf8");
    await ssh.upload(hostName, localSource, remotePath);
    await ssh.download(hostName, remotePath, localDownload);

    await expect(readFile(localDownload, "utf8")).resolves.toBe("sftp-ok\n");
  });

  test("close with cleanupOnClose removes persisted logs", async () => {
    const ssh = getManager();
    await ssh.connect(hostName);

    const record = await ssh.execWait(hostName, "echo cleanup-ok", { timeoutSeconds: 10 });
    const historyPath = ssh.history.pathFor(hostName, record.connectionId);
    expect(existsSync(historyPath)).toBe(true);

    await ssh.close(hostName);

    expect(existsSync(historyPath)).toBe(false);
    expect(ssh.listHistory(hostName)).toEqual([]);
  });
});

async function assertDockerAvailable(): Promise<void> {
  try {
    await docker(["version", "--format", "{{.Server.Version}}"], 10_000);
  } catch (error) {
    throw new Error(`Docker required for OpenSSH integration test: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeProjectConfig(port: number | undefined): Promise<void> {
  if (port === undefined || !Number.isInteger(port)) {
    throw new Error("Docker did not report an OpenSSH mapped port");
  }

  await writeJson(join(projectDirectory, "opencode-ssh.json"), {
    hosts: [
      {
        name: hostName,
        host: "127.0.0.1",
        port,
        username: sshUser,
        password: sshPassword,
        hostKey: { mode: "accept-new" },
      },
    ],
    history: {
      enabled: true,
      cleanupOnClose: true,
    },
  });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value), "utf8");
}

function getManager(): SSHManager {
  if (manager === undefined) {
    throw new Error("OpenSSH integration manager was not initialized");
  }
  return manager;
}

function getMappedPort(): number {
  if (mappedPort === undefined) {
    throw new Error("OpenSSH integration mapped port was not initialized");
  }
  return mappedPort;
}

async function cleanup(): Promise<void> {
  if (manager !== undefined) {
    await manager.dispose().catch(() => {});
    manager = undefined;
  }
  await docker(["rm", "--force", containerName], 30_000).catch(() => {});
  await docker(["rmi", "--force", imageName], 30_000).catch(() => {});
  await rm(testRoot, { force: true, recursive: true });
}

async function docker(args: string[], timeoutMs: number): Promise<string> {
  return runWithTimeout("docker", args, timeoutMs);
}

async function runWithTimeout(command: string, args: string[], timeoutMs: number): Promise<string> {
  const proc = Bun.spawn([command, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  let killed = false;
  const timeout = setTimeout(() => {
    killed = true;
    proc.kill();
  }, timeoutMs);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (killed) {
      throw new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`);
    }
    if (exitCode !== 0) {
      throw new Error(`${command} ${args.join(" ")} failed with exit code ${exitCode}: ${stderr.trim() || stdout.trim()}`);
    }
    return stdout.trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function waitFor<T>(
  callback: () => T | undefined | false | Promise<T | undefined | false>,
  description: string,
  timeoutMs = 10_000,
): Promise<T> {
  const startedAt = Date.now();
  let value = await callback();
  while (!value && Date.now() - startedAt < timeoutMs) {
    await Bun.sleep(50);
    value = await callback();
  }
  if (!value) {
    throw new Error(`Timed out waiting for ${description}`);
  }
  return value;
}
