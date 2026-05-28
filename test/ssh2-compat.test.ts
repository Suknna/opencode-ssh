import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";

const testRoot = join(process.cwd(), ".tmp", "ssh2-compat");
const fixtureRoot = join(process.cwd(), "test", "fixtures", "openssh");
const imageTag = `opencode-ssh2-compat:${Date.now()}`;
const containerName = `opencode-ssh2-compat-${Date.now()}-${process.pid}`;
const dockerTimeoutMs = 30_000;
const cleanupTimeoutMs = 10_000;
const operationTimeoutMs = 10_000;
let builtImage = false;
let startedContainer = false;

describe("ssh2 Bun compatibility", () => {
  afterAll(async () => {
    await cleanupDockerArtifacts();
    await rm(testRoot, { force: true, recursive: true });
  });

  test("imports Client from ssh2", () => {
    expect(typeof Client).toBe("function");
  });

  test("connects to OpenSSH and supports exec, PTY shell, and SFTP", async () => {
    if (!(await dockerAvailable())) {
      throw new Error("Docker required for ssh2 OpenSSH compatibility test");
    }

    await rm(testRoot, { force: true, recursive: true });
    await mkdir(testRoot, { recursive: true });

    await docker(["build", "-t", imageTag, fixtureRoot]);
    builtImage = true;
    await docker(["run", "-d", "--name", containerName, "-p", "127.0.0.1::2222", imageTag]);
    startedContainer = true;

    const config: ConnectConfig = {
      host: "127.0.0.1",
      port: await mappedPort(containerName),
      username: "testuser",
      password: "testpass",
      readyTimeout: 10_000,
    };

    await waitForSSH(config);
    const client = await connect(config);

    try {
      await expect(exec(client, "echo ok")).resolves.toContain("ok");
      await expect(ptyEcho(client)).resolves.toContain("pty-ok");
      await expect(sftpRoundTrip(client)).resolves.toBe("sftp-ok\n");
    } finally {
      client.end();
    }
  }, 60_000);
});

async function dockerAvailable(): Promise<boolean> {
  if (Bun.which("docker") === null) {
    return false;
  }

  const result = await spawn(["docker", "info"], dockerTimeoutMs);
  return result.exitCode === 0;
}

async function docker(args: string[]): Promise<string> {
  const result = await spawn(["docker", ...args], dockerTimeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(`docker ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

async function cleanupDockerArtifacts(): Promise<void> {
  if (!(await dockerAvailable())) {
    return;
  }

  if (startedContainer) {
    await spawn(["docker", "rm", "-f", containerName], cleanupTimeoutMs);
  }
  if (builtImage) {
    await spawn(["docker", "rmi", "-f", imageTag], cleanupTimeoutMs);
  }
}

async function mappedPort(name: string): Promise<number> {
  const output = await docker(["port", name, "2222/tcp"]);
  const match = output.match(/127\.0\.0\.1:(\d+)/);
  if (!match?.[1]) {
    throw new Error(`could not resolve mapped SSH port from docker output: ${output}`);
  }
  return Number(match[1]);
}

async function spawn(
  command: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  const proc = Bun.spawn(command, {
    cwd: process.cwd(),
    signal: abortController.signal,
    stderr: "pipe",
    stdout: "pipe",
  });

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    return { exitCode, stderr, stdout };
  } catch (error) {
    return {
      exitCode: 124,
      stderr: error instanceof Error ? error.message : String(error),
      stdout: "",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForSSH(config: ConnectConfig): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const client = await connect(config);
      client.end();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(250);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("connect timed out waiting for OpenSSH fixture");
}

function connect(config: ConnectConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error("connect timed out"));
    }, operationTimeoutMs);

    client.once("ready", () => {
      clearTimeout(timeout);
      resolve(client);
    });
    client.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`connect failed: ${error.message}`));
    });
    client.connect(config);
  });
}

function exec(client: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const operation = `exec ${command}`;
    const timeout = setTimeout(() => reject(new Error(`${operation} timed out`)), operationTimeoutMs);

    client.exec(command, (error, channel) => {
      if (error) {
        clearTimeout(timeout);
        reject(new Error(`${operation} failed: ${error.message}`));
        return;
      }

      let exitCode = 0;
      let stdout = "";
      let stderr = "";
      channel.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      channel.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      channel.once("exit", (code: number) => {
        exitCode = code;
      });
      channel.once("close", () => {
        clearTimeout(timeout);
        if (exitCode === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`${operation} exited with ${exitCode}: ${stderr}`));
        }
      });
      channel.once("error", (streamError: Error) => {
        clearTimeout(timeout);
        reject(new Error(`${operation} failed: ${streamError.message}`));
      });
    });
  });
}

function ptyEcho(client: Client): Promise<string> {
  return new Promise((resolve, reject) => {
    const operation = "shell pty";
    let settled = false;
    let output = "";
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error(`${operation} timed out: ${output}`));
    }, operationTimeoutMs);

    client.shell({ cols: 80, rows: 24, term: "xterm" }, (error, channel) => {
      if (error) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`${operation} failed: ${error.message}`));
        return;
      }

      channel.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (!settled && output.includes("pty-ok")) {
          settled = true;
          clearTimeout(timeout);
          channel.write("exit\n");
          resolve(output);
        }
      });
      channel.once("close", () => clearTimeout(timeout));
      channel.once("error", (streamError: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`${operation} failed: ${streamError.message}`));
      });
      channel.write("echo pty-ok\n");
    });
  });
}

async function sftpRoundTrip(client: Client): Promise<string> {
  const uploadPath = join(testRoot, "upload.txt");
  const downloadPath = join(testRoot, "download.txt");
  await writeFile(uploadPath, "sftp-ok\n", "utf8");

  const sftp = await openSftp(client);

  try {
    await mkdirRemote(sftp, "/home/testuser/upload");
    await fastPut(sftp, uploadPath, "/home/testuser/upload/file.txt");
    await fastGet(sftp, "/home/testuser/upload/file.txt", downloadPath);

    return readFile(downloadPath, "utf8");
  } finally {
    sftp.end();
  }
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    const operation = "sftp open";
    const timeout = setTimeout(() => reject(new Error(`${operation} timed out`)), operationTimeoutMs);

    client.sftp((error, sftp) => {
      if (error) {
        clearTimeout(timeout);
        reject(new Error(`${operation} failed: ${error.message}`));
        return;
      }
      clearTimeout(timeout);
      resolve(sftp);
    });
  });
}

function mkdirRemote(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const operation = "sftp mkdir";
    const timeout = setTimeout(() => reject(new Error(`${operation} timed out`)), operationTimeoutMs);

    sftp.mkdir(path, (error) => {
      if (!error) {
        clearTimeout(timeout);
        resolve();
        return;
      }

      sftp.stat(path, (statError, stats) => {
        clearTimeout(timeout);
        if (!statError && stats.isDirectory()) {
          resolve();
        } else {
          reject(new Error(`${operation} failed: ${error.message}`));
        }
      });
    });
  });
}

function fastPut(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const operation = "fastPut";
    const timeout = setTimeout(() => reject(new Error(`${operation} timed out`)), operationTimeoutMs);

    sftp.fastPut(localPath, remotePath, (error) => {
      if (error) {
        clearTimeout(timeout);
        reject(new Error(`${operation} failed: ${error.message}`));
        return;
      }
      clearTimeout(timeout);
      resolve();
    });
  });
}

function fastGet(sftp: SFTPWrapper, remotePath: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const operation = "fastGet";
    const timeout = setTimeout(() => reject(new Error(`${operation} timed out`)), operationTimeoutMs);

    sftp.fastGet(remotePath, localPath, (error) => {
      if (error) {
        clearTimeout(timeout);
        reject(new Error(`${operation} failed: ${error.message}`));
        return;
      }
      clearTimeout(timeout);
      resolve();
    });
  });
}
