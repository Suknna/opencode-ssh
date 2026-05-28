import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";
import type { Client, ClientChannel, ExecOptions, SFTPWrapper } from "ssh2";

import type { SSHPluginConfig } from "../src/config/types.js";
import { SSHManager, SSHManagerError } from "../src/ssh/manager.js";

const config: SSHPluginConfig = {
  hosts: [
    {
      name: "dev",
      host: "127.0.0.1",
      port: 22,
      username: "tester",
      password: "secret",
    },
  ],
  history: {
    cleanupOnClose: true,
    enabled: true,
  },
};

describe("SSHManager", () => {
  test("deduplicates repeated connect calls while a host is connecting", async () => {
    const deferred = createDeferred<Client>();
    const client = createFakeClient();
    let connectCalls = 0;
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory() }, {
      connectHost: async () => {
        connectCalls += 1;
        return deferred.promise;
      },
    });

    const first = manager.connect("dev");
    const second = manager.connect("dev");
    expect(connectCalls).toBe(1);

    deferred.resolve(client);
    const [firstState, secondState] = await Promise.all([first, second]);

    expect(firstState).toBe(secondState);
    expect(firstState.status).toBe("connected");
    expect(firstState.client).toBe(client);
  });

  test("close cancels pending connects and remains idempotent for inactive configured hosts", async () => {
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory() }, {
      connectHost: async (_host, signal) =>
        new Promise<Client>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted by test")), { once: true });
        }),
    });

    const pending = manager.connect("dev");
    const pendingResult = pending.catch((error: unknown) => error);
    await manager.close("dev");

    expect(await pendingResult).toBeInstanceOf(SSHManagerError);
    await expect(manager.close("dev")).resolves.toBeUndefined();
  });

  test("close ends a client that resolves after the host was closed", async () => {
    const deferred = createDeferred<Client>();
    const client = createFakeClient();
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory() }, {
      connectHost: async () => deferred.promise,
    });

    const pending = manager.connect("dev");
    const pendingResult = pending.catch((error: unknown) => error);
    const closePromise = manager.close("dev");
    deferred.resolve(client);

    await closePromise;
    expect(await pendingResult).toBeInstanceOf(SSHManagerError);
    expect(client.endCalls).toBe(1);
    expect(client.destroyCalls).toBe(1);
  });

  test("close cancels running commands and removes in-memory history for the host", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    (client as { exec: (command: string, options: ExecOptions, callback: ExecCallback) => Client }).exec = (_command, _options, callback) => {
      callback(undefined, channel);
      return client;
    };
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("close-running-command") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    const record = await manager.execBackground("dev", "sleep 60");

    await manager.close("dev");

    expect(record.status).toBe("cancelled");
    expect(record.error).toBe("Command cancelled.");
    expect(channel.closeCalls).toBe(1);
    expect(manager.listHistory("dev")).toEqual([]);
    await expect(manager.close("dev")).resolves.toBeUndefined();
    expect(client.endCalls).toBe(1);
  });

  test("close ignores late command output after cleanup", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    (client as { exec: (command: string, options: ExecOptions, callback: ExecCallback) => Client }).exec = (_command, _options, callback) => {
      callback(undefined, channel);
      return client;
    };
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("close-command-late-output") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    const record = await manager.execBackground("dev", "sleep 60");
    await manager.close("dev");
    channel.emit("data", Buffer.from("late stdout\n"));
    channel.stderr.emit("data", Buffer.from("late stderr\n"));
    await Bun.sleep(0);

    expect(record.status).toBe("cancelled");
    expect(record.stdout).toBe("");
    expect(record.stderr).toBe("");
    await expect(manager.history.read("dev", record.connectionId)).resolves.toBe("");
  });

  test("close waits for pending command history append before cleanup", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    const appendDeferred = createDeferred<void>();
    let closeResolved = false;
    (client as { exec: (command: string, options: ExecOptions, callback: ExecCallback) => Client }).exec = (_command, _options, callback) => {
      callback(undefined, channel);
      return client;
    };
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("close-command-pending-history") }, {
      connectHost: async () => client,
    });
    const append = manager.history.append.bind(manager.history);
    manager.history.append = async (hostName, connectionId, recordId, chunk) => {
      await appendDeferred.promise;
      await append(hostName, connectionId, recordId, chunk);
    };

    await manager.connect("dev");
    const record = await manager.execBackground("dev", "sleep 60");
    channel.emit("data", Buffer.from("late\n"));
    const closePromise = manager.close("dev").then(() => {
      closeResolved = true;
    });
    await Bun.sleep(0);

    expect(closeResolved).toBe(false);
    appendDeferred.resolve();
    await closePromise;
    await expect(manager.history.read("dev", record.connectionId)).resolves.toBe("");
    await Bun.sleep(0);
    await expect(manager.history.read("dev", record.connectionId)).resolves.toBe("");
  });

  test("execWait collects stdout and stderr, records status, and appends history", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    let execCommand = "";
    let execOptions: ExecOptions | undefined;
    (client as { exec: (command: string, options: ExecOptions, callback: (error: Error | undefined, channel: ClientChannel) => void) => Client }).exec = (command, options, callback) => {
      execCommand = command;
      execOptions = options;
      callback(undefined, channel);
      queueMicrotask(() => {
        channel.emit("data", Buffer.from("hello\n"));
        channel.stderr.emit("data", Buffer.from("warn\n"));
        channel.emit("exit", 0);
        channel.emit("close");
      });
      return client;
    };
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("exec-wait") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    const record = await manager.execWait("dev", "echo hello", { env: { TEST_ENV: "1" } });

    expect(execCommand).toBe("echo hello");
    expect(execOptions).toEqual({ env: { TEST_ENV: "1" } });
    expect(record.status).toBe("completed");
    expect(record.exitCode).toBe(0);
    expect(record.stdout).toBe("hello\n");
    expect(record.stderr).toBe("warn\n");
    expect(record.completedAt).toBeInstanceOf(Date);
    await expect(manager.history.read("dev", record.connectionId)).resolves.toBe("hello\nwarn\n");
  });

  test("close cleans up disk and in-memory command history", async () => {
    const client = createFakeClient();
    installImmediateExec(client, "hello\n");
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("close-history-cleanup") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    const record = await manager.execWait("dev", "echo hello");
    await expect(manager.history.read("dev", record.connectionId)).resolves.toBe("hello\n");

    await manager.close("dev");

    expect(manager.listHistory("dev")).toEqual([]);
    await expect(manager.history.read("dev", record.connectionId)).resolves.toBe("");
  });

  test("execWait waits for pending history append before resolving", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    const appendDeferred = createDeferred<void>();
    let appendText = "";
    let resolved = false;
    (client as { exec: (command: string, options: ExecOptions, callback: ExecCallback) => Client }).exec = (_command, _options, callback) => {
      callback(undefined, channel);
      queueMicrotask(() => {
        channel.emit("data", Buffer.from("tail\n"));
        channel.emit("exit", 0);
        channel.emit("close");
      });
      return client;
    };
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("exec-history-wait") }, {
      connectHost: async () => client,
    });
    manager.history.append = async (_hostName, _connectionId, _recordId, chunk) => {
      appendText += chunk;
      await appendDeferred.promise;
    };

    await manager.connect("dev");
    const pendingRecord = manager.execWait("dev", "echo tail").then((record) => {
      resolved = true;
      return record;
    });
    await Bun.sleep(0);

    expect(appendText).toBe("tail\n");
    expect(resolved).toBe(false);
    appendDeferred.resolve();
    const record = await pendingRecord;

    expect(resolved).toBe(true);
    expect(record.status).toBe("completed");
  });

  test("execWait keeps history append failures diagnostic on the record", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    (client as { exec: (command: string, options: ExecOptions, callback: ExecCallback) => Client }).exec = (_command, _options, callback) => {
      callback(undefined, channel);
      queueMicrotask(() => {
        channel.emit("data", Buffer.from("lost\n"));
        channel.emit("exit", 0);
        channel.emit("close");
      });
      return client;
    };
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("exec-history-error") }, {
      connectHost: async () => client,
    });
    manager.history.append = async () => {
      throw new Error("disk full");
    };

    await manager.connect("dev");
    const record = await manager.execWait("dev", "echo lost");

    expect(record.status).toBe("completed");
    expect(record.error).toBe("History append failed: disk full");
  });

  test("execWait marks non-zero exit status as failed with exitCode", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    (client as { exec: (command: string, options: ExecOptions, callback: ExecCallback) => Client }).exec = (_command, _options, callback) => {
      callback(undefined, channel);
      queueMicrotask(() => {
        channel.emit("exit", 2);
        channel.emit("close");
      });
      return client;
    };
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("exec-exit-failed") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    const record = await manager.execWait("dev", "false");

    expect(record.status).toBe("failed");
    expect(record.exitCode).toBe(2);
  });

  test("execWait marks exec callback errors as failed with diagnostics", async () => {
    const client = createFakeClient();
    (client as { exec: (command: string, options: ExecOptions, callback: ExecCallback) => Client }).exec = (_command, _options, callback) => {
      callback(new Error("open channel failed"), createFakeChannel());
      return client;
    };
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("exec-callback-error") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    const record = await manager.execWait("dev", "whoami");

    expect(record.status).toBe("failed");
    expect(record.error).toBe("open channel failed");
  });

  test("execWait rejects cwd instead of unsafe shell concatenation", async () => {
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("exec-cwd") }, {
      connectHost: async () => createFakeClient(),
    });

    await manager.connect("dev");

    await expect(manager.execWait("dev", "pwd", { cwd: "/tmp/work dir" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "cwd unsupported for now",
    });
  });

  test("execWait marks a pre-aborted command as cancelled without opening a channel", async () => {
    const client = createFakeClient();
    let execCalls = 0;
    (client as { exec: Client["exec"] }).exec = ((
      _command: string,
      _optionsOrCallback: ExecOptions | ExecCallback,
      _callback?: ExecCallback,
    ) => {
      execCalls += 1;
      return client;
    }) as Client["exec"];
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("exec-pre-abort") }, {
      connectHost: async () => client,
    });
    const abortController = new AbortController();
    abortController.abort();

    await manager.connect("dev");
    const record = await manager.execWait("dev", "echo hello", { abort: abortController.signal });

    expect(execCalls).toBe(0);
    expect(record.status).toBe("cancelled");
    expect(record.error).toBe("Command cancelled.");
  });

  test("execWait abort closes an active channel and marks the record cancelled", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    const abortController = new AbortController();
    (client as { exec: (command: string, options: ExecOptions, callback: ExecCallback) => Client }).exec = (_command, _options, callback) => {
      callback(undefined, channel);
      return client;
    };
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("exec-abort") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    const pendingRecord = manager.execWait("dev", "sleep 60", { abort: abortController.signal });
    await Bun.sleep(0);
    abortController.abort();
    const record = await pendingRecord;

    expect(record.status).toBe("cancelled");
    expect(record.error).toBe("Command cancelled.");
    expect(channel.closeCalls).toBe(1);
  });

  test("execWait timeout is not overwritten by a later channel close", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    (client as { exec: (command: string, options: ExecOptions, callback: ExecCallback) => Client }).exec = (_command, _options, callback) => {
      callback(undefined, channel);
      return client;
    };
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("exec-timeout-close") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    const record = await manager.execWait("dev", "sleep 60", { timeoutSeconds: 0.001 });
    channel.emit("exit", 0);
    channel.emit("close");

    expect(record.status).toBe("timeout");
    expect(record.error).toBe("Command timed out.");
    expect(record.exitCode).toBeUndefined();
    expect(channel.closeCalls).toBe(1);
  });

  test("execWait channel error is not overwritten by a later channel close", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    (client as { exec: (command: string, options: ExecOptions, callback: ExecCallback) => Client }).exec = (_command, _options, callback) => {
      callback(undefined, channel);
      queueMicrotask(() => {
        channel.emit("error", new Error("stream failed"));
        channel.emit("exit", 0);
        channel.emit("close");
      });
      return client;
    };
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("exec-channel-error-close") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    const record = await manager.execWait("dev", "whoami");

    expect(record.status).toBe("failed");
    expect(record.error).toBe("stream failed");
    expect(record.exitCode).toBeUndefined();
  });

  test("upload opens sftp and calls fastPut", async () => {
    const client = createFakeClient();
    const sftp = createFakeSftp();
    installImmediateSftp(client, sftp);
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("sftp-upload") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    await manager.upload("dev", "/local/file.txt", "/remote/file.txt");

    expect(sftp.fastPutCalls).toEqual([["/local/file.txt", "/remote/file.txt"]]);
    expect(sftp.fastGetCalls).toEqual([]);
    expect(sftp.endCalls).toBe(1);
  });

  test("download opens sftp and calls fastGet", async () => {
    const client = createFakeClient();
    const sftp = createFakeSftp();
    installImmediateSftp(client, sftp);
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("sftp-download") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    await manager.download("dev", "/remote/file.txt", "/local/file.txt");

    expect(sftp.fastGetCalls).toEqual([["/remote/file.txt", "/local/file.txt"]]);
    expect(sftp.fastPutCalls).toEqual([]);
    expect(sftp.endCalls).toBe(1);
  });

  test("upload reports sftp open errors without leaking raw details", async () => {
    const client = createFakeClient();
    installSftpOpenError(client, new Error("password=secret"));
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("sftp-upload-open-error") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");

    await expect(manager.upload("dev", "/local/file.txt", "/remote/file.txt")).rejects.toMatchObject({
      code: "TRANSFER_FAILED",
      message: "SFTP open failed",
      hostName: "dev",
    });
    await expect(manager.upload("dev", "/local/file.txt", "/remote/file.txt")).rejects.not.toThrow("password=secret");
  });

  test("upload reports sftp open sync throws without leaking raw details", async () => {
    const client = createFakeClient();
    installSftpOpenThrow(client, new Error("password=secret"));
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("sftp-upload-open-throw") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");

    await expect(manager.upload("dev", "/local/file.txt", "/remote/file.txt")).rejects.toMatchObject({
      code: "TRANSFER_FAILED",
      message: "SFTP open failed",
      hostName: "dev",
    });
    await expect(manager.upload("dev", "/local/file.txt", "/remote/file.txt")).rejects.not.toThrow("password=secret");
  });

  test("upload reports fastPut errors without leaking raw details", async () => {
    const client = createFakeClient();
    const sftp = createFakeSftp({ fastPutError: new Error("token=secret") });
    installImmediateSftp(client, sftp);
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("sftp-upload-fastput-error") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");

    await expect(manager.upload("dev", "/local/file.txt", "/remote/file.txt")).rejects.toMatchObject({
      code: "TRANSFER_FAILED",
      message: "SFTP upload failed",
      hostName: "dev",
    });
    await expect(manager.upload("dev", "/local/file.txt", "/remote/file.txt")).rejects.not.toThrow("token=secret");
    expect(sftp.endCalls).toBe(2);
  });

  test("upload reports fastPut sync throws without leaking raw details", async () => {
    const client = createFakeClient();
    const sftp = createFakeSftp({ fastPutThrow: new Error("token=secret") });
    installImmediateSftp(client, sftp);
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("sftp-upload-fastput-throw") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");

    await expect(manager.upload("dev", "/local/file.txt", "/remote/file.txt")).rejects.toMatchObject({
      code: "TRANSFER_FAILED",
      message: "SFTP upload failed",
      hostName: "dev",
    });
    await expect(manager.upload("dev", "/local/file.txt", "/remote/file.txt")).rejects.not.toThrow("token=secret");
    expect(sftp.endCalls).toBe(2);
  });

  test("download reports fastGet errors without leaking raw details", async () => {
    const client = createFakeClient();
    const sftp = createFakeSftp({ fastGetError: new Error("secret-key") });
    installImmediateSftp(client, sftp);
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("sftp-download-fastget-error") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");

    await expect(manager.download("dev", "/remote/file.txt", "/local/file.txt")).rejects.toMatchObject({
      code: "TRANSFER_FAILED",
      message: "SFTP download failed",
      hostName: "dev",
    });
    await expect(manager.download("dev", "/remote/file.txt", "/local/file.txt")).rejects.not.toThrow("secret-key");
    expect(sftp.endCalls).toBe(2);
  });

  test("download reports fastGet sync throws without leaking raw details", async () => {
    const client = createFakeClient();
    const sftp = createFakeSftp({ fastGetThrow: new Error("secret-key") });
    installImmediateSftp(client, sftp);
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("sftp-download-fastget-throw") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");

    await expect(manager.download("dev", "/remote/file.txt", "/local/file.txt")).rejects.toMatchObject({
      code: "TRANSFER_FAILED",
      message: "SFTP download failed",
      hostName: "dev",
    });
    await expect(manager.download("dev", "/remote/file.txt", "/local/file.txt")).rejects.not.toThrow("secret-key");
    expect(sftp.endCalls).toBe(2);
  });

  test("upload ignores duplicate transfer callbacks and closes sftp once", async () => {
    const client = createFakeClient();
    const sftp = createFakeSftp({ fastPutCallbacks: [undefined, new Error("token=secret")] });
    installImmediateSftp(client, sftp);
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("sftp-upload-double-callback") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    await expect(manager.upload("dev", "/local/file.txt", "/remote/file.txt")).resolves.toBeUndefined();

    expect(sftp.fastPutCalls).toEqual([["/local/file.txt", "/remote/file.txt"]]);
    expect(sftp.endCalls).toBe(1);
  });

  test("download cleanup errors do not replace transfer errors", async () => {
    const client = createFakeClient();
    const sftp = createFakeSftp({ fastGetError: new Error("primary-secret"), endThrow: new Error("cleanup-secret") });
    installImmediateSftp(client, sftp);
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("sftp-download-cleanup-error") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");

    await expect(manager.download("dev", "/remote/file.txt", "/local/file.txt")).rejects.toMatchObject({
      code: "TRANSFER_FAILED",
      message: "SFTP download failed",
      hostName: "dev",
    });
    await expect(manager.download("dev", "/remote/file.txt", "/local/file.txt")).rejects.not.toThrow("primary-secret");
    await expect(manager.download("dev", "/remote/file.txt", "/local/file.txt")).rejects.not.toThrow("cleanup-secret");
    expect(sftp.endCalls).toBe(3);
  });

  test("execBackground returns immediately and completes asynchronously", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    const closeDeferred = createDeferred<void>();
    (client as { exec: (command: string, options: ExecOptions, callback: (error: Error | undefined, channel: ClientChannel) => void) => Client }).exec = (_command, _options, callback) => {
      callback(undefined, channel);
      return client;
    };
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("exec-background") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    const record = await manager.execBackground("dev", "sleep 1");

    expect(record.status).toBe("running");
    channel.emit("data", Buffer.from("done\n"));
    channel.once("close", () => closeDeferred.resolve());
    channel.emit("exit", 0);
    channel.emit("close");
    await closeDeferred.promise;
    await Bun.sleep(0);

    expect(record.status).toBe("completed");
    expect(record.stdout).toBe("done\n");
  });

  test("listHistory returns command records and filters by host", async () => {
    const clients = [createFakeClient(), createFakeClient()];
    clients.forEach((client) => installImmediateExec(client, "out\n"));
    const manager = new SSHManager({ config: multiHostConfig(), projectDirectory: testProjectDirectory("history-list") }, {
      connectHost: async () => clients.shift() ?? createFakeClient(),
    });

    await manager.connect("dev");
    await manager.connect("prod");
    const devRecord = await manager.execWait("dev", "echo dev");
    const prodRecord = await manager.execWait("prod", "echo prod");

    expect(manager.listHistory().map((record) => record.hostName)).toEqual(["dev", "prod"]);
    expect(manager.listHistory("prod")).toEqual([prodRecord]);
    expect(manager.listHistory("dev")).toEqual([devRecord]);
  });

  test("readHistory returns paginated output from a record", async () => {
    const client = createFakeClient();
    installImmediateExec(client, "one\ntwo\nthree\n", "warn\n");
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("history-read") }, {
      connectHost: async () => client,
    });
    await manager.connect("dev");
    const record = await manager.execWait("dev", "printf");

    expect(manager.readHistory({ id: record.id, offset: 2, limit: 2 })).toEqual({
      id: record.id,
      hostName: "dev",
      status: "completed",
      lines: ["two", "three"],
      startLine: 2,
      hasMore: true,
    });
  });

  test("readHistory returns empty output for empty records and out-of-range offsets", async () => {
    const client = createFakeClient();
    installImmediateExec(client);
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("history-empty") }, {
      connectHost: async () => client,
    });
    await manager.connect("dev");
    const emptyRecord = await manager.execWait("dev", "true");

    expect(manager.readHistory({ id: emptyRecord.id, offset: 1, limit: 100 })).toEqual({
      id: emptyRecord.id,
      hostName: "dev",
      status: "completed",
      lines: [],
      startLine: 1,
      hasMore: false,
    });

    const outputClient = createFakeClient();
    installImmediateExec(outputClient, "one\ntwo\n");
    const outputManager = new SSHManager({ config, projectDirectory: testProjectDirectory("history-offset-bounds") }, {
      connectHost: async () => outputClient,
    });
    await outputManager.connect("dev");
    const outputRecord = await outputManager.execWait("dev", "printf");

    expect(outputManager.readHistory({ id: outputRecord.id, offset: 10, limit: 5 })).toEqual({
      id: outputRecord.id,
      hostName: "dev",
      status: "completed",
      lines: [],
      startLine: 10,
      hasMore: false,
    });
  });

  test("readHistory filters by pattern and ignoreCase before pagination", async () => {
    const client = createFakeClient();
    installImmediateExec(client, "ok\nError A\nERROR B\n");
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("history-pattern") }, {
      connectHost: async () => client,
    });
    await manager.connect("dev");
    const record = await manager.execWait("dev", "scan");

    expect(manager.readHistory({ id: record.id, offset: 2, limit: 1, pattern: "error", ignoreCase: true })).toEqual({
      id: record.id,
      hostName: "dev",
      status: "completed",
      lines: ["ERROR B"],
      startLine: 2,
      hasMore: false,
    });
  });

  test("readHistory throws HISTORY_NOT_FOUND for an unknown id", async () => {
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("history-missing") }, {
      connectHost: async () => createFakeClient(),
    });

    expect(() => manager.readHistory({ id: "secret-token", offset: 1, limit: 100 })).toThrow(SSHManagerError);
    expect(() => manager.readHistory({ id: "secret-token", offset: 1, limit: 100 })).toThrow("SSH history record was not found");
    expect(() => manager.readHistory({ id: "secret-token", offset: 1, limit: 100 })).not.toThrow("secret-token");
  });

  test("ptyStart opens a shell, writes an optional command, and collects output", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    let shellOptions: ShellOptions | undefined;
    (client as { shell: (options: ShellOptions, callback: ShellCallback) => Client }).shell = (options, callback) => {
      shellOptions = options;
      callback(undefined, channel);
      return client;
    };
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("pty-start") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    const session = await manager.ptyStart("dev", { command: "top", cols: 100, rows: 40 });
    channel.emit("data", Buffer.from("one\ntwo\nthree\nfour\n"));

    expect(shellOptions).toEqual({ cols: 100, rows: 40, term: "xterm-256color" });
    expect(channel.writeCalls).toEqual(["top\n"]);
    expect(session.status).toBe("running");
    expect(manager.ptyRead(session.id, 2, 2)).toEqual({
      id: session.id,
      hostName: "dev",
      status: "running",
      lines: ["two", "three"],
      startLine: 2,
      hasMore: true,
    });
  });

  test("ptyStart caps buffered output by discarding the oldest data", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    installImmediateShell(client, channel);
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("pty-buffer-cap") }, {
      connectHost: async () => client,
      maxPtyBufferChars: 12,
    });

    await manager.connect("dev");
    const session = await manager.ptyStart("dev");
    channel.emit("data", Buffer.from("old-one\n"));
    channel.emit("data", Buffer.from("new-two\n"));

    const page = manager.ptyRead(session.id, 1, 10);

    expect(session.bufferSize).toBeLessThanOrEqual(12);
    expect(page.lines).toContain("[pty output truncated: oldest data discarded]");
    expect(page.lines.join("\n")).not.toContain("old-one");
    expect(page.lines.join("\n")).toContain("new-two");
  });

  test("ptyWrite decodes control sequences and writes raw data to a running channel", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    installImmediateShell(client, channel);
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("pty-write") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    const session = await manager.ptyStart("dev");
    const written = manager.ptyWrite(session.id, "ls\\n");

    expect(written).toBe(3);
    expect(channel.writeCalls).toEqual(["ls\n"]);
  });

  test("ptyWrite rejects invalid control sequences", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    installImmediateShell(client, channel);
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("pty-write-invalid-control") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    const session = await manager.ptyStart("dev");

    expect(() => manager.ptyWrite(session.id, "bad\\xZZ")).toThrow("Invalid \\xNN control sequence.");
    expect(channel.writeCalls).toEqual([]);
  });

  test("ptyResize calls channel setWindow with rows then cols", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    installImmediateShell(client, channel);
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("pty-resize") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    const session = await manager.ptyStart("dev");
    const resized = manager.ptyResize(session.id, 132, 50);

    expect(resized).toBe(session);
    expect(channel.setWindowCalls).toEqual([[50, 132, 0, 0]]);
  });

  test("ptyResize throws PTY_FAILED when the channel cannot resize", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    Reflect.deleteProperty(channel, "setWindow");
    installImmediateShell(client, channel);
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("pty-resize-unsupported") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    const session = await manager.ptyStart("dev");

    expect(() => manager.ptyResize(session.id, 132, 50)).toThrow(SSHManagerError);
    expect(() => manager.ptyResize(session.id, 132, 50)).toThrow("SSH PTY channel does not support resize.");
  });

  test("ptyKill closes a running channel and remains idempotent", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    installImmediateShell(client, channel);
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("pty-kill") }, {
      connectHost: async () => client,
    });

    await manager.connect("dev");
    const session = await manager.ptyStart("dev");
    const first = manager.ptyKill(session.id);
    const second = manager.ptyKill(session.id);

    expect(first.status).toBe("closed");
    expect(second.status).toBe("closed");
    expect(channel.closeCalls).toBe(1);
  });

  test("close removes only the target host PTY sessions", async () => {
    const devClient = createFakeClient();
    const prodClient = createFakeClient();
    const devChannel = createFakeChannel();
    const prodChannel = createFakeChannel();
    installImmediateShell(devClient, devChannel);
    installImmediateShell(prodClient, prodChannel);
    const clients = new Map<string, Client>([
      ["dev", devClient],
      ["prod", prodClient],
    ]);
    const manager = new SSHManager({ config: multiHostConfig(), projectDirectory: testProjectDirectory("pty-close-host") }, {
      connectHost: async (host) => clients.get(host.name) ?? createFakeClient(),
    });

    await manager.connect("dev");
    await manager.connect("prod");
    const devSession = await manager.ptyStart("dev");
    const prodSession = await manager.ptyStart("prod");
    devChannel.emit("data", Buffer.from("dev output\n"));
    prodChannel.emit("data", Buffer.from("prod output\n"));

    await manager.close("dev");

    expect(devChannel.closeCalls).toBe(1);
    expect(() => manager.ptyRead(devSession.id, 1, 10)).toThrow(SSHManagerError);
    expect(() => manager.ptyRead(devSession.id, 1, 10)).toThrow("SSH PTY session was not found");
    expect(manager.ptyRead(prodSession.id, 1, 10)).toEqual({
      id: prodSession.id,
      hostName: "prod",
      status: "running",
      lines: ["prod output"],
      startLine: 1,
      hasMore: false,
    });
  });

  test("close waits for pending PTY history append before cleanup", async () => {
    const client = createFakeClient();
    const channel = createFakeChannel();
    const appendDeferred = createDeferred<void>();
    let closeResolved = false;
    installImmediateShell(client, channel);
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("close-pty-pending-history") }, {
      connectHost: async () => client,
    });
    const append = manager.history.append.bind(manager.history);
    manager.history.append = async (hostName, connectionId, recordId, chunk) => {
      await appendDeferred.promise;
      await append(hostName, connectionId, recordId, chunk);
    };

    await manager.connect("dev");
    const session = await manager.ptyStart("dev");
    channel.emit("data", Buffer.from("late pty\n"));
    const closePromise = manager.close("dev").then(() => {
      closeResolved = true;
    });
    await Bun.sleep(0);

    expect(closeResolved).toBe(false);
    appendDeferred.resolve();
    await closePromise;
    await expect(manager.history.read("dev", session.connectionId)).resolves.toBe("");
    await Bun.sleep(0);
    await expect(manager.history.read("dev", session.connectionId)).resolves.toBe("");
  });

  test("ptyRead throws PTY_NOT_FOUND without leaking the requested id", async () => {
    const manager = new SSHManager({ config, projectDirectory: testProjectDirectory("pty-missing") }, {
      connectHost: async () => createFakeClient(),
    });

    expect(() => manager.ptyRead("secret-token", 1, 100)).toThrow(SSHManagerError);
    expect(() => manager.ptyRead("secret-token", 1, 100)).toThrow("SSH PTY session was not found");
    expect(() => manager.ptyRead("secret-token", 1, 100)).not.toThrow("secret-token");
  });
});

function createDeferred<T>(): { promise: Promise<T>; reject: (error: Error) => void; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

type ExecCallback = (error: Error | undefined, channel: ClientChannel) => void;
type ShellOptions = { cols: number; rows: number; term: string };
type ShellCallback = (error: Error | undefined, channel: ClientChannel) => void;
type SftpCallback = (error: Error | undefined, sftp: SFTPWrapper) => void;
type SftpTransferCallback = (error?: Error | null) => void;
type SftpTransfer = (source: string, destination: string, callback: SftpTransferCallback) => void;

function createFakeClient(): Client & { destroyCalls: number; endCalls: number } {
  const client = new EventEmitter() as Client & { destroyCalls: number; endCalls: number };
  client.destroyCalls = 0;
  client.endCalls = 0;
  client.destroy = () => {
    client.destroyCalls += 1;
    return client;
  };
  client.end = () => {
    client.endCalls += 1;
    return client;
  };
  return client;
}

type FakeChannel = ClientChannel & { closeCalls: number; setWindowCalls: Array<[number, number, number, number]>; writeCalls: string[] };

function createFakeChannel(): FakeChannel {
  const channel = new EventEmitter() as FakeChannel;
  channel.closeCalls = 0;
  channel.setWindowCalls = [];
  channel.writeCalls = [];
  channel.stderr = new PassThrough();
  channel.close = () => {
    channel.closeCalls += 1;
  };
  channel.setWindow = (rows: number, cols: number, height: number, width: number) => {
    channel.setWindowCalls.push([rows, cols, height, width]);
  };
  channel.write = (chunk: string | Buffer) => {
    channel.writeCalls.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    return true;
  };
  return channel;
}

function installImmediateShell(client: Client, channel = createFakeChannel()): void {
  (client as { shell: (options: ShellOptions, callback: ShellCallback) => Client }).shell = (_options, callback) => {
    callback(undefined, channel);
    return client;
  };
}

function installImmediateSftp(client: Client, sftp: FakeSftp): void {
  (client as { sftp: (callback: SftpCallback) => Client }).sftp = (callback) => {
    callback(undefined, sftp);
    return client;
  };
}

function installSftpOpenError(client: Client, error: Error): void {
  (client as { sftp: (callback: SftpCallback) => Client }).sftp = (callback) => {
    callback(error, createFakeSftp());
    return client;
  };
}

function installSftpOpenThrow(client: Client, error: Error): void {
  (client as { sftp: (callback: SftpCallback) => Client }).sftp = () => {
    throw error;
  };
}

type FakeSftp = SFTPWrapper & { endCalls: number; fastGetCalls: Array<[string, string]>; fastPutCalls: Array<[string, string]> };

function createFakeSftp(
  options: {
    endThrow?: Error;
    fastGetCallbacks?: Array<Error | null | undefined>;
    fastGetError?: Error;
    fastGetThrow?: Error;
    fastPutCallbacks?: Array<Error | null | undefined>;
    fastPutError?: Error;
    fastPutThrow?: Error;
  } = {},
): FakeSftp {
  const sftp = new EventEmitter() as FakeSftp;
  sftp.endCalls = 0;
  sftp.fastGetCalls = [];
  sftp.fastPutCalls = [];
  const fastGet: SftpTransfer = (remotePath, localPath, callback) => {
    sftp.fastGetCalls.push([remotePath, localPath]);
    if (options.fastGetThrow !== undefined) {
      throw options.fastGetThrow;
    }
    for (const error of options.fastGetCallbacks ?? [options.fastGetError]) {
      callback(error);
    }
  };
  const fastPut: SftpTransfer = (localPath, remotePath, callback) => {
    sftp.fastPutCalls.push([localPath, remotePath]);
    if (options.fastPutThrow !== undefined) {
      throw options.fastPutThrow;
    }
    for (const error of options.fastPutCallbacks ?? [options.fastPutError]) {
      callback(error);
    }
  };
  sftp.end = () => {
    sftp.endCalls += 1;
    if (options.endThrow !== undefined) {
      throw options.endThrow;
    }
  };
  sftp.fastGet = fastGet as SFTPWrapper["fastGet"];
  sftp.fastPut = fastPut as SFTPWrapper["fastPut"];
  return sftp;
}

function installImmediateExec(client: Client, stdout = "", stderr = ""): void {
  (client as { exec: (command: string, options: ExecOptions, callback: ExecCallback) => Client }).exec = (_command, _options, callback) => {
    const channel = createFakeChannel();
    callback(undefined, channel);
    queueMicrotask(() => {
      if (stdout !== "") {
        channel.emit("data", Buffer.from(stdout));
      }
      if (stderr !== "") {
        channel.stderr.emit("data", Buffer.from(stderr));
      }
      channel.emit("exit", 0);
      channel.emit("close");
    });
    return client;
  };
}

function testProjectDirectory(suffix = "default"): string {
  return join(process.cwd(), ".tmp", "manager-test", suffix);
}

function multiHostConfig(): SSHPluginConfig {
  return {
    ...config,
    hosts: [
      ...config.hosts,
      {
        name: "prod",
        host: "192.0.2.10",
        port: 22,
        username: "tester",
        password: "secret",
      },
    ],
  };
}
