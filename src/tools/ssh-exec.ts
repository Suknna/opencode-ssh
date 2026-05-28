import { tool } from "@opencode-ai/plugin";

import { escapeXml, formatSSHError } from "../shared/errors.js";
import type { SSHCommandRecord, SSHExecOptions } from "../ssh/types.js";
import type { MinimalSSHManager } from "./create-tools.js";

const schema = tool.schema;

export function createSSHExecTool(manager: MinimalSSHManager) {
  return tool({
    description: "Execute a remote SSH command in wait or background mode.",
    args: {
      hostName: schema.string().describe("Name of the connected SSH host."),
      command: schema.string().describe("Remote command to execute."),
      mode: schema.enum(["wait", "background"]).optional().describe("Execution mode. Defaults to wait."),
      timeoutSeconds: schema.number().int().positive().max(86400).optional().describe("Optional command timeout in seconds."),
      cwd: schema.string().optional().describe("Unsupported for now; returns CONFIG_INVALID when provided."),
      env: schema.record(schema.string(), schema.string()).optional().describe("Environment variables for ssh2 exec options."),
    },
    execute: async ({ hostName, command, mode, timeoutSeconds, cwd, env }, context) => {
      const execOptions: SSHExecOptions = { abort: context.abort };
      if (timeoutSeconds !== undefined) {
        execOptions.timeoutSeconds = timeoutSeconds;
      }
      if (cwd !== undefined) {
        execOptions.cwd = cwd;
      }
      if (env !== undefined) {
        execOptions.env = env;
      }

      try {
        const record = mode === "background"
          ? await manager.execBackground(hostName, command, execOptions)
          : await manager.execWait(hostName, command, execOptions);
        return {
          title: mode === "background" ? "SSH command started" : "SSH command completed",
          output: formatSSHExec(record, mode ?? "wait"),
          metadata: { commandId: record.id, hostName, status: record.status, exitCode: record.exitCode },
        };
      } catch (error) {
        const code = errorCode(error);
        return {
          title: "SSH exec failed",
          output: formatSSHError(code, hostName, safeErrorMessage(code)),
        };
      }
    },
  });
}

function formatSSHExec(record: SSHCommandRecord, mode: "wait" | "background"): string {
  const exitCodeAttribute = record.exitCode === undefined ? "" : ` exitCode="${record.exitCode}"`;
  if (mode === "background") {
    return `<ssh_exec commandId="${escapeXml(record.id)}" host="${escapeXml(record.hostName)}" status="${escapeXml(record.status)}"${exitCodeAttribute}></ssh_exec>`;
  }

  return [
    `<ssh_output commandId="${escapeXml(record.id)}" host="${escapeXml(record.hostName)}" status="${escapeXml(record.status)}"${exitCodeAttribute}>`,
    `<stdout>${escapeXml(record.stdout ?? "")}</stdout>`,
    `<stderr>${escapeXml(record.stderr ?? "")}</stderr>`,
    "</ssh_output>",
  ].join("\n");
}

function errorCode(error: unknown): string {
  if (isErrorWithCode(error)) {
    return isSafeErrorCode(error.code) ? error.code : "COMMAND_FAILED";
  }
  return "COMMAND_FAILED";
}

function safeErrorMessage(code: string): string {
  if (code === "HOST_NOT_FOUND") {
    return "SSH host is not configured.";
  }
  if (code === "CONNECT_FAILED") {
    return "SSH host is not connected.";
  }
  if (code === "CONFIG_INVALID") {
    return "cwd unsupported for now.";
  }
  return "SSH command failed.";
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string";
}

function isSafeErrorCode(code: string): code is "HOST_NOT_FOUND" | "CONNECT_FAILED" | "CONFIG_INVALID" | "COMMAND_FAILED" {
  return code === "HOST_NOT_FOUND" || code === "CONNECT_FAILED" || code === "CONFIG_INVALID" || code === "COMMAND_FAILED";
}
