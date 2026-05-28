import { describe, expect, test } from "bun:test";
import type { ToolContext, ToolResult } from "@opencode-ai/plugin";

import type { OutputPage, SSHCommandRecord, SSHConnectionState, SSHExecOptions, SSHHostSummary, SSHPtySession, SSHPtyStartOptions } from "../src/ssh/types.js";
import type { MinimalSSHManager } from "../src/tools/create-tools.js";
import { createSSHCloseTool } from "../src/tools/ssh-close.js";
import { createSSHConnectTool } from "../src/tools/ssh-connect.js";
import { createSSHDownloadTool } from "../src/tools/ssh-download.js";
import { createSSHExecTool } from "../src/tools/ssh-exec.js";
import { createSSHHistoryTool } from "../src/tools/ssh-history.js";
import { createSSHListTool } from "../src/tools/ssh-list.js";
import { createSSHPtyTool, decodeControlSequences } from "../src/tools/ssh-pty.js";
import { createSSHUploadTool } from "../src/tools/ssh-upload.js";

describe("SSH tools", () => {
  test("ssh_list returns host summaries without secret fields", async () => {
    const manager = createFakeManager({
      hosts: [
        {
          name: "dev",
          host: "127.0.0.1",
          username: "tester",
          connected: true,
          description: "Development host",
          password: "secret-password",
          passwordEnv: "SSH_PASSWORD",
          privateKeyPath: "/secret/key",
          passphrase: "legacy-secret-passphrase",
          privateKeyPassphrase: "secret-passphrase",
          privateKeyPassphraseEnv: "SSH_KEY_PASSPHRASE",
          env: "SECRET_ENV_VALUE",
        } as SSHHostSummary,
      ],
    });
    const tool = createSSHListTool(manager);

    const result = expectObjectResult(await tool.execute({}, createToolContext()));

    expect(result).toEqual({
      title: "SSH hosts",
      output:
        '<ssh_hosts>\n  <ssh_host name="dev" host="127.0.0.1" username="tester" connected="true" description="Development host"></ssh_host>\n</ssh_hosts>',
    });
    expect(result.output).not.toContain("secret-password");
    expect(result.output).not.toContain("SSH_PASSWORD");
    expect(result.output).not.toContain("/secret/key");
    expect(result.output).not.toContain("legacy-secret-passphrase");
    expect(result.output).not.toContain("secret-passphrase");
    expect(result.output).not.toContain("SSH_KEY_PASSPHRASE");
    expect(result.output).not.toContain("SECRET_ENV_VALUE");
    expect(result.output).not.toContain("password");
    expect(result.output).not.toContain("passwordEnv");
    expect(result.output).not.toContain("privateKeyPath");
    expect(result.output).not.toContain("passphrase");
    expect(result.output).not.toContain("privateKeyPassphrase");
    expect(result.output).not.toContain("privateKeyPassphraseEnv");
    expect(result.output).not.toContain("env");
  });

  test("ssh_connect returns success metadata", async () => {
    const manager = createFakeManager({
      connect: async (hostName) => createConnectionState(hostName, "ssh_conn_test"),
    });
    const tool = createSSHConnectTool(manager);

    const result = expectObjectResult(await tool.execute({ hostName: "dev" }, createToolContext()));

    expect(result.output).toContain("<ssh_connected");
    expect(result.metadata).toEqual({ hostName: "dev", connectionId: "ssh_conn_test" });
  });

  test("ssh_connect returns ssh_error when the manager throws", async () => {
    const manager = createFakeManager({
      connect: async () => {
        throw Object.assign(new Error("password=secret"), { code: "CONNECT_FAILED" });
      },
    });
    const tool = createSSHConnectTool(manager);

    const result = expectObjectResult(await tool.execute({ hostName: "dev" }, createToolContext()));

    expect(result.output).toContain("<ssh_error");
    expect(result.output).toBe('<ssh_error code="CONNECT_FAILED" host="dev">SSH connection failed.</ssh_error>');
    expect(result.output).not.toContain("password=secret");
  });

  test("ssh_connect returns ssh_error when the timeout aborts the connection", async () => {
    const manager = createFakeManager({
      connect: async (_hostName, signal) =>
        new Promise<SSHConnectionState>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("secret timeout detail")), { once: true });
        }),
    });
    const tool = createSSHConnectTool(manager);

    const result = expectObjectResult(await tool.execute({ hostName: "dev", timeoutSeconds: 1 }, createToolContext()));

    expect(result.output).toBe('<ssh_error code="CONNECT_TIMEOUT" host="dev">SSH connection timed out.</ssh_error>');
    expect(result.output).not.toContain("secret timeout detail");
  });

  test("ssh_close closes one host and returns metadata", async () => {
    const closedHosts: Array<string | undefined> = [];
    const manager = createFakeManager({
      close: async (hostName) => {
        closedHosts.push(hostName);
      },
    });
    const tool = createSSHCloseTool(manager);

    const result = expectObjectResult(await tool.execute({ hostName: "prod-api" }, createToolContext()));

    expect(closedHosts).toEqual(["prod-api"]);
    expect(result).toEqual({
      title: "SSH closed",
      output: '<ssh_closed host="prod-api"></ssh_closed>',
      metadata: { hostName: "prod-api" },
    });
  });

  test("ssh_close closes all hosts when hostName is omitted", async () => {
    const closedHosts: Array<string | undefined> = [];
    const manager = createFakeManager({
      close: async (hostName) => {
        closedHosts.push(hostName);
      },
    });
    const tool = createSSHCloseTool(manager);

    const result = expectObjectResult(await tool.execute({}, createToolContext()));

    expect(closedHosts).toEqual([undefined]);
    expect(result).toEqual({
      title: "SSH closed",
      output: '<ssh_closed host="all"></ssh_closed>',
      metadata: { all: true },
    });
  });

  test("ssh_close redacts manager error details", async () => {
    const manager = createFakeManager({
      close: async () => {
        throw Object.assign(new Error("password=secret"), { code: "CLOSE_FAILED" });
      },
    });
    const tool = createSSHCloseTool(manager);

    const result = expectObjectResult(await tool.execute({ hostName: "dev" }, createToolContext()));

    expect(result.output).toBe('<ssh_error code="CLOSE_FAILED" host="dev">SSH close failed.</ssh_error>');
    expect(result.output).not.toContain("password=secret");
  });

  test("ssh_exec wait returns command output metadata", async () => {
    const context = createToolContext();
    const manager = createFakeManager({
      execWait: async (hostName, command, options) => {
        expect(options).toEqual({ abort: context.abort });
        return createCommandRecord(hostName, command, "completed", 0, "ok\n", "warn\n");
      },
    });
    const tool = createSSHExecTool(manager);

    const result = expectObjectResult(await tool.execute({ hostName: "dev", command: "echo ok" }, context));

    expect(result.title).toBe("SSH command completed");
    expect(result.output).toContain('<ssh_output commandId="ssh_cmd_test" host="dev" status="completed" exitCode="0">');
    expect(result.output).toContain("<stdout>ok\n</stdout>");
    expect(result.output).toContain("<stderr>warn\n</stderr>");
    expect(result.metadata).toEqual({ commandId: "ssh_cmd_test", hostName: "dev", status: "completed", exitCode: 0 });
  });

  test("ssh_exec background returns a running command id", async () => {
    const manager = createFakeManager({
      execBackground: async (hostName, command) => createCommandRecord(hostName, command, "running"),
    });
    const tool = createSSHExecTool(manager);

    const result = expectObjectResult(
      await tool.execute({ hostName: "dev", command: "sleep 60", mode: "background" }, createToolContext()),
    );

    expect(result.title).toBe("SSH command started");
    expect(result.output).toBe('<ssh_exec commandId="ssh_cmd_test" host="dev" status="running"></ssh_exec>');
    expect(result.metadata).toEqual({ commandId: "ssh_cmd_test", hostName: "dev", status: "running", exitCode: undefined });
  });

  test("ssh_exec reports cwd as unsupported without unsafe command rewriting", async () => {
    const manager = createFakeManager({
      execWait: async (_hostName, _command, options) => {
        expect(options?.cwd).toBe("/unsafe path");
        throw Object.assign(new Error("cwd unsupported for now: secret=/tmp/key"), { code: "CONFIG_INVALID" });
      },
    });
    const tool = createSSHExecTool(manager);

    const result = expectObjectResult(
      await tool.execute({ hostName: "dev", command: "pwd", cwd: "/unsafe path" }, createToolContext()),
    );

    expect(result.output).toBe('<ssh_error code="CONFIG_INVALID" host="dev">cwd unsupported for now.</ssh_error>');
    expect(result.output).not.toContain("secret=/tmp/key");
  });

  test("ssh_exec redacts manager error details", async () => {
    const manager = createFakeManager({
      execWait: async () => {
        throw Object.assign(new Error("token=secret"), { code: "COMMAND_FAILED" });
      },
    });
    const tool = createSSHExecTool(manager);

    const result = expectObjectResult(await tool.execute({ hostName: "dev", command: "whoami" }, createToolContext()));

    expect(result.output).toBe('<ssh_error code="COMMAND_FAILED" host="dev">SSH command failed.</ssh_error>');
    expect(result.output).not.toContain("token=secret");
  });

  test("ssh_exec rejects unsafe manager error codes", async () => {
    const manager = createFakeManager({
      execWait: async () => {
        throw Object.assign(new Error("secret failure"), { code: "token=secret" });
      },
    });
    const tool = createSSHExecTool(manager);

    const result = expectObjectResult(await tool.execute({ hostName: "dev", command: "whoami" }, createToolContext()));

    expect(result.output).toBe('<ssh_error code="COMMAND_FAILED" host="dev">SSH command failed.</ssh_error>');
    expect(result.output).not.toContain("token=secret");
    expect(result.output).not.toContain("secret failure");
  });

  test("ssh_upload returns completed transfer metadata", async () => {
    const manager = createFakeManager({
      upload: async (hostName, localPath, remotePath) => {
        expect([hostName, localPath, remotePath]).toEqual(["dev", "/local/file.txt", "/remote/file.txt"]);
      },
    });
    const tool = createSSHUploadTool(manager);

    const result = expectObjectResult(
      await tool.execute({ hostName: "dev", localPath: "/local/file.txt", remotePath: "/remote/file.txt" }, createToolContext()),
    );

    expect(result.title).toBe("SSH upload completed");
    expect(result.output).toBe('<ssh_transfer direction="upload" status="completed" host="dev" localPath="/local/file.txt" remotePath="/remote/file.txt"></ssh_transfer>');
    expect(result.metadata).toEqual({ direction: "upload", hostName: "dev", localPath: "/local/file.txt", remotePath: "/remote/file.txt", status: "completed" });
  });

  test("ssh_upload escapes transfer attributes", async () => {
    const manager = createFakeManager({
      upload: async (hostName, localPath, remotePath) => {
        expect([hostName, localPath, remotePath]).toEqual(['dev&"<>', '/local/&"<>', '/remote/&"<>']);
      },
    });
    const tool = createSSHUploadTool(manager);

    const result = expectObjectResult(
      await tool.execute({ hostName: 'dev&"<>', localPath: '/local/&"<>', remotePath: '/remote/&"<>' }, createToolContext()),
    );

    expect(result.output).toBe('<ssh_transfer direction="upload" status="completed" host="dev&amp;&quot;&lt;&gt;" localPath="/local/&amp;&quot;&lt;&gt;" remotePath="/remote/&amp;&quot;&lt;&gt;"></ssh_transfer>');
  });

  test("ssh_upload redacts manager error details", async () => {
    const manager = createFakeManager({
      upload: async () => {
        throw Object.assign(new Error("token=secret"), { code: "TRANSFER_FAILED" });
      },
    });
    const tool = createSSHUploadTool(manager);

    const result = expectObjectResult(
      await tool.execute({ hostName: "dev", localPath: "/local/secret", remotePath: "/remote/file" }, createToolContext()),
    );

    expect(result.output).toBe('<ssh_error code="TRANSFER_FAILED" host="dev">SSH upload failed.</ssh_error>');
    expect(result.output).not.toContain("token=secret");
    expect(result.output).not.toContain("/local/secret");
  });

  test("ssh_download returns completed transfer metadata", async () => {
    const manager = createFakeManager({
      download: async (hostName, remotePath, localPath) => {
        expect([hostName, remotePath, localPath]).toEqual(["dev", "/remote/file.txt", "/local/file.txt"]);
      },
    });
    const tool = createSSHDownloadTool(manager);

    const result = expectObjectResult(
      await tool.execute({ hostName: "dev", remotePath: "/remote/file.txt", localPath: "/local/file.txt" }, createToolContext()),
    );

    expect(result.title).toBe("SSH download completed");
    expect(result.output).toBe('<ssh_transfer direction="download" status="completed" host="dev" remotePath="/remote/file.txt" localPath="/local/file.txt"></ssh_transfer>');
    expect(result.metadata).toEqual({ direction: "download", hostName: "dev", remotePath: "/remote/file.txt", localPath: "/local/file.txt", status: "completed" });
  });

  test("ssh_download escapes transfer attributes", async () => {
    const manager = createFakeManager({
      download: async (hostName, remotePath, localPath) => {
        expect([hostName, remotePath, localPath]).toEqual(['dev&"<>', '/remote/&"<>', '/local/&"<>']);
      },
    });
    const tool = createSSHDownloadTool(manager);

    const result = expectObjectResult(
      await tool.execute({ hostName: 'dev&"<>', remotePath: '/remote/&"<>', localPath: '/local/&"<>' }, createToolContext()),
    );

    expect(result.output).toBe('<ssh_transfer direction="download" status="completed" host="dev&amp;&quot;&lt;&gt;" remotePath="/remote/&amp;&quot;&lt;&gt;" localPath="/local/&amp;&quot;&lt;&gt;"></ssh_transfer>');
  });

  test("ssh_download redacts manager error details", async () => {
    const manager = createFakeManager({
      download: async () => {
        throw Object.assign(new Error("password=secret"), { code: "TRANSFER_FAILED" });
      },
    });
    const tool = createSSHDownloadTool(manager);

    const result = expectObjectResult(
      await tool.execute({ hostName: "dev", remotePath: "/remote/secret", localPath: "/local/file" }, createToolContext()),
    );

    expect(result.output).toBe('<ssh_error code="TRANSFER_FAILED" host="dev">SSH download failed.</ssh_error>');
    expect(result.output).not.toContain("password=secret");
    expect(result.output).not.toContain("/remote/secret");
  });

  test("ssh_history list returns summaries without full output and escapes XML", async () => {
    const manager = createFakeManager({
      listHistory: () => [{
        ...createCommandRecord('dev&"', 'echo "<ok>"', "completed", 0, "secret stdout\n", "secret stderr\n"),
        id: 'ssh_cmd_&"<test>',
        error: "secret error",
      }],
    });
    const tool = createSSHHistoryTool(manager);

    const result = expectObjectResult(await tool.execute({ action: "list" }, createToolContext()));

    expect(result.output).toBe(
      '<ssh_history>\n  <ssh_history_record id="ssh_cmd_&amp;&quot;&lt;test&gt;" host="dev&amp;&quot;" status="completed" command="echo &quot;&lt;ok&gt;&quot;" exitCode="0"></ssh_history_record>\n</ssh_history>',
    );
    expect(result.output).not.toContain("secret stdout");
    expect(result.output).not.toContain("secret stderr");
    expect(result.output).not.toContain("secret error");
    expect(result.output).not.toContain("stdout");
    expect(result.output).not.toContain("stderr");
    expect(result.output).not.toContain("error");
  });

  test("ssh_history list passes optional host filter", async () => {
    const manager = createFakeManager({
      listHistory: (hostName) => {
        expect(hostName).toBe("prod");
        return [];
      },
    });
    const tool = createSSHHistoryTool(manager);

    const result = expectObjectResult(await tool.execute({ action: "list", hostName: "prod" }, createToolContext()));

    expect(result.output).toBe("<ssh_history>\n</ssh_history>");
  });

  test("ssh_history read formats paginated output", async () => {
    const manager = createFakeManager({
      readHistory: (input) => {
        expect(input).toEqual({ id: "ssh_cmd_test", offset: 2, limit: 2, ignoreCase: false });
        return { id: input.id, hostName: "dev", status: "completed", startLine: 2, lines: ["two", "three"], hasMore: true };
      },
    });
    const tool = createSSHHistoryTool(manager);

    const result = expectObjectResult(
      await tool.execute({ action: "read", id: "ssh_cmd_test", offset: 2, limit: 2 }, createToolContext()),
    );

    expect(result.output).toContain('<ssh_output id="ssh_cmd_test" host="dev" status="completed">');
    expect(result.output).toContain("00002| two");
    expect(result.output).toContain("00003| three");
    expect(result.output).toContain("<ssh_more>true</ssh_more>");
  });

  test("ssh_history read passes pattern and ignoreCase", async () => {
    const manager = createFakeManager({
      readHistory: (input) => {
        expect(input).toEqual({ id: "ssh_cmd_test", offset: 1, limit: 100, pattern: "ERROR", ignoreCase: true });
        return { id: input.id, hostName: "dev", status: "completed", lines: ["error line"] };
      },
    });
    const tool = createSSHHistoryTool(manager);

    const result = expectObjectResult(
      await tool.execute({ action: "read", id: "ssh_cmd_test", pattern: "ERROR", ignoreCase: true }, createToolContext()),
    );

    expect(result.output).toContain("00001| error line");
  });

  test("ssh_history read without id returns CONFIG_INVALID", async () => {
    const tool = createSSHHistoryTool(createFakeManager());

    const result = expectObjectResult(await tool.execute({ action: "read" }, createToolContext()));

    expect(result.output).toBe('<ssh_error code="CONFIG_INVALID">SSH history id is required for read.</ssh_error>');
  });

  test("ssh_history read redacts not found details", async () => {
    const manager = createFakeManager({
      readHistory: () => {
        throw Object.assign(new Error('SSH history "secret-token" was not found'), { code: "HISTORY_NOT_FOUND", hostName: "dev" });
      },
    });
    const tool = createSSHHistoryTool(manager);

    const result = expectObjectResult(await tool.execute({ action: "read", id: "secret-token" }, createToolContext()));

    expect(result.output).toBe('<ssh_error code="HISTORY_NOT_FOUND" host="dev">SSH history record was not found.</ssh_error>');
    expect(result.output).not.toContain("secret-token");
  });

  test("ssh_pty decodes control sequences", () => {
    expect(decodeControlSequences("one\\ntwo\\r\\t\\x21\\u263a\\q")).toBe("one\ntwo\r\t!☺\\q");
    expect(() => decodeControlSequences("bad\\xZ1")).toThrow("Invalid \\xNN control sequence.");
    expect(() => decodeControlSequences("bad\\u12ZZ")).toThrow("Invalid \\uNNNN control sequence.");
  });

  test("ssh_pty start passes defaults and returns session metadata", async () => {
    const manager = createFakeManager({
      ptyStart: async (hostName, options) => {
        expect(hostName).toBe("dev");
        expect(options).toEqual({ command: "top", cols: 120, rows: 30 });
        return createPtySession(hostName);
      },
    });
    const tool = createSSHPtyTool(manager);

    const result = expectObjectResult(await tool.execute({ action: "start", hostName: "dev", command: "top" }, createToolContext()));

    expect(result.title).toBe("SSH PTY started");
    expect(result.output).toBe('<ssh_pty id="ssh_pty_test" host="dev" connectionId="ssh_conn_test" status="running"></ssh_pty>');
    expect(result.metadata).toEqual({ ptySessionId: "ssh_pty_test", hostName: "dev", status: "running" });
  });

  test("ssh_pty write validates required fields and decodes data", async () => {
    let writtenData = "";
    const manager = createFakeManager({
      ptyWrite: (id, data) => {
        expect(id).toBe("ssh_pty_test");
        writtenData = data;
        return Buffer.byteLength(decodeControlSequences(data), "utf8");
      },
    });
    const tool = createSSHPtyTool(manager);

    const missing = expectObjectResult(await tool.execute({ action: "write", ptySessionId: "ssh_pty_test" }, createToolContext()));
    const result = expectObjectResult(await tool.execute({ action: "write", ptySessionId: "ssh_pty_test", data: "ls\\n" }, createToolContext()));

    expect(missing.output).toBe('<ssh_error code="CONFIG_INVALID">SSH PTY data is required for write.</ssh_error>');
    expect(writtenData).toBe("ls\\n");
    expect(result.output).toBe('<ssh_pty id="ssh_pty_test" written="3"></ssh_pty>');
  });

  test("ssh_pty read formats output with pagination", async () => {
    const manager = createFakeManager({
      ptyRead: (id, offset, limit) => {
        expect([id, offset, limit]).toEqual(["ssh_pty_test", 2, 2]);
        return { id, hostName: "dev", status: "running", startLine: 2, lines: ["two", "three"], hasMore: true };
      },
    });
    const tool = createSSHPtyTool(manager);

    const result = expectObjectResult(await tool.execute({ action: "read", ptySessionId: "ssh_pty_test", offset: 2, limit: 2 }, createToolContext()));

    expect(result.output).toContain('<ssh_output id="ssh_pty_test" host="dev" status="running">');
    expect(result.output).toContain("00002| two");
    expect(result.output).toContain("<ssh_more>true</ssh_more>");
  });

  test("ssh_pty resize and kill return structured status", async () => {
    const calls: string[] = [];
    const manager = createFakeManager({
      ptyResize: (id, cols, rows) => {
        calls.push(`resize:${id}:${cols}:${rows}`);
        return createPtySession("dev");
      },
      ptyKill: (id) => {
        calls.push(`kill:${id}`);
        return { ...createPtySession("dev"), status: "closed" };
      },
    });
    const tool = createSSHPtyTool(manager);

    const resize = expectObjectResult(await tool.execute({ action: "resize", ptySessionId: "ssh_pty_test", cols: 100, rows: 40 }, createToolContext()));
    const kill = expectObjectResult(await tool.execute({ action: "kill", ptySessionId: "ssh_pty_test" }, createToolContext()));

    expect(calls).toEqual(["resize:ssh_pty_test:100:40", "kill:ssh_pty_test"]);
    expect(resize.output).toBe('<ssh_pty id="ssh_pty_test" status="running" cols="100" rows="40"></ssh_pty>');
    expect(kill.output).toBe('<ssh_pty id="ssh_pty_test" status="closed"></ssh_pty>');
  });

  test("ssh_pty validates action-specific session id", async () => {
    const tool = createSSHPtyTool(createFakeManager());

    const result = expectObjectResult(await tool.execute({ action: "read" }, createToolContext()));

    expect(result.output).toBe('<ssh_error code="CONFIG_INVALID">SSH PTY session id is required for read.</ssh_error>');
  });

  test("ssh_pty start validates required host name", async () => {
    const tool = createSSHPtyTool(createFakeManager());

    const result = expectObjectResult(await tool.execute({ action: "start" }, createToolContext()));

    expect(result.output).toBe('<ssh_error code="CONFIG_INVALID">SSH host name is required for PTY start.</ssh_error>');
  });

  test("ssh_pty invalid control sequence returns CONFIG_INVALID without leaking data", async () => {
    const manager = createFakeManager({
      ptyWrite: (_id, data) => {
        return Buffer.byteLength(decodeControlSequences(data), "utf8");
      },
    });
    const tool = createSSHPtyTool(manager);

    const result = expectObjectResult(await tool.execute({ action: "write", ptySessionId: "ssh_pty_test", data: "token=secret\\xZZ" }, createToolContext()));

    expect(result.output).toBe('<ssh_error code="CONFIG_INVALID">SSH PTY arguments are invalid.</ssh_error>');
    expect(result.output).not.toContain("token=secret");
    expect(result.output).not.toContain("xZZ");
  });

  test("ssh_pty redacts manager error details", async () => {
    const manager = createFakeManager({
      ptyRead: () => {
        throw Object.assign(new Error("token=secret"), { code: "PTY_NOT_FOUND", hostName: "dev" });
      },
    });
    const tool = createSSHPtyTool(manager);

    const result = expectObjectResult(await tool.execute({ action: "read", ptySessionId: "secret-token" }, createToolContext()));

    expect(result.output).toBe('<ssh_error code="PTY_NOT_FOUND" host="dev">SSH PTY session was not found.</ssh_error>');
    expect(result.output).not.toContain("token=secret");
    expect(result.output).not.toContain("secret-token");
  });
});

function createFakeManager(overrides: Partial<MinimalSSHManager> & { hosts?: SSHHostSummary[] } = {}): MinimalSSHManager {
  return {
    listHosts: () => overrides.hosts ?? [],
    connect: overrides.connect ?? (async (hostName) => createConnectionState(hostName, "ssh_conn_default")),
    execWait: overrides.execWait ?? (async (hostName, command) => createCommandRecord(hostName, command, "completed", 0)),
    execBackground: overrides.execBackground ?? (async (hostName, command) => createCommandRecord(hostName, command, "running")),
    upload: overrides.upload ?? (async () => {}),
    download: overrides.download ?? (async () => {}),
    ptyStart: overrides.ptyStart ?? (async (hostName) => createPtySession(hostName)),
    ptyWrite: overrides.ptyWrite ?? ((_id, data) => Buffer.byteLength(data, "utf8")),
    ptyRead: overrides.ptyRead ?? ((id) => createOutputPage(id)),
    ptyResize: overrides.ptyResize ?? ((_id) => createPtySession("dev")),
    ptyKill: overrides.ptyKill ?? ((_id) => ({ ...createPtySession("dev"), status: "closed" })),
    listHistory: overrides.listHistory ?? (() => []),
    readHistory: overrides.readHistory ?? ((input) => ({ id: input.id, hostName: "dev", status: "completed", lines: [] })),
    close: overrides.close ?? (async () => {}),
    dispose: async () => {},
  };
}

function createPtySession(hostName: string): SSHPtySession {
  return {
    id: "ssh_pty_test",
    hostName,
    connectionId: "ssh_conn_test",
    status: "running",
    buffer: [],
    bufferSize: 0,
    startedAt: new Date(0),
    channel: {} as SSHPtySession["channel"],
  };
}

function createOutputPage(id: string): OutputPage {
  return { id, hostName: "dev", status: "running", lines: [] };
}

function expectObjectResult(result: ToolResult): Exclude<ToolResult, string> {
  expect(typeof result).toBe("object");
  return result as Exclude<ToolResult, string>;
}

function createConnectionState(hostName: string, id: string): SSHConnectionState {
  return {
    id,
    host: {
      name: hostName,
      host: "127.0.0.1",
      port: 22,
      username: "tester",
    },
    status: "connected",
    createdAt: new Date(0),
  };
}

function createCommandRecord(
  hostName: string,
  command: string,
  status: SSHCommandRecord["status"],
  exitCode?: number,
  stdout = "",
  stderr = "",
): SSHCommandRecord {
  const record: SSHCommandRecord = {
    id: "ssh_cmd_test",
    connectionId: "ssh_conn_test",
    hostName,
    command,
    status,
    startedAt: new Date(0),
    stdout,
    stderr,
  };
  if (status !== "running") {
    record.completedAt = new Date(1);
    record.finishedAt = record.completedAt;
  }
  if (exitCode !== undefined) {
    record.exitCode = exitCode;
  }
  return record;
}


function createToolContext(): ToolContext {
  return {
    sessionID: "session",
    messageID: "message",
    agent: "agent",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}
