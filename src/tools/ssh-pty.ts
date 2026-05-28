import { tool } from "@opencode-ai/plugin";

import { formatSSHOutput } from "../history/formatter.js";
import { escapeXml, formatSSHError } from "../shared/errors.js";
export { decodeControlSequences } from "../ssh/control.js";
import type { SSHPtySession } from "../ssh/types.js";
import type { MinimalSSHManager } from "./create-tools.js";

const schema = tool.schema;

export function createSSHPtyTool(_manager: MinimalSSHManager) {
  return tool({
    description: "Start, write to, read from, resize, or kill an interactive SSH PTY session.",
    args: {
      action: schema.enum(["start", "write", "read", "resize", "kill"]).describe("PTY action to perform."),
      hostName: schema.string().optional().describe("Configured SSH host name. Required for start."),
      ptySessionId: schema.string().optional().describe("PTY session id. Required for write/read/resize/kill."),
      command: schema.string().optional().describe("Optional command to send after the shell starts."),
      data: schema.string().optional().describe("Raw input for write. Supports \\n, \\r, \\t, \\xNN, and \\uNNNN escapes."),
      cols: schema.number().int().min(20).max(300).optional().describe("Terminal columns. Defaults to 120."),
      rows: schema.number().int().min(5).max(100).optional().describe("Terminal rows. Defaults to 30."),
      offset: schema.number().int().min(1).optional().describe("1-based output line offset. Defaults to 1."),
      limit: schema.number().int().min(1).max(500).optional().describe("Maximum output lines to read. Defaults to 100."),
    },
    execute: async ({ action, hostName, ptySessionId, command, data, cols, rows, offset, limit }) => {
      try {
        if (action === "start") {
          if (hostName === undefined) {
            return invalid("SSH host name is required for PTY start.");
          }
          const startOptions = { cols: cols ?? 120, rows: rows ?? 30, ...(command === undefined ? {} : { command }) };
          const session = await _manager.ptyStart(hostName, startOptions);
          return {
            title: "SSH PTY started",
            output: formatPtySession(session),
            metadata: { ptySessionId: session.id, hostName: session.hostName, status: session.status },
          };
        }

        if (ptySessionId === undefined) {
          return invalid(`SSH PTY session id is required for ${action}.`, hostName);
        }

        if (action === "write") {
          if (data === undefined) {
            return invalid("SSH PTY data is required for write.", hostName);
          }
          const written = _manager.ptyWrite(ptySessionId, data);
          return {
            title: "SSH PTY wrote input",
            output: `<ssh_pty id="${escapeXml(ptySessionId)}" written="${written}"></ssh_pty>`,
            metadata: { ptySessionId, written },
          };
        }

        if (action === "read") {
          return {
            title: "SSH PTY output",
            output: formatSSHOutput(_manager.ptyRead(ptySessionId, offset ?? 1, limit ?? 100)),
          };
        }

        if (action === "resize") {
          const session = _manager.ptyResize(ptySessionId, cols ?? 120, rows ?? 30);
          return {
            title: "SSH PTY resized",
            output: `<ssh_pty id="${escapeXml(session.id)}" status="${escapeXml(session.status)}" cols="${cols ?? 120}" rows="${rows ?? 30}"></ssh_pty>`,
            metadata: { ptySessionId: session.id, status: session.status },
          };
        }

        const session = _manager.ptyKill(ptySessionId);
        return {
          title: "SSH PTY killed",
          output: `<ssh_pty id="${escapeXml(session.id)}" status="${escapeXml(session.status)}"></ssh_pty>`,
          metadata: { ptySessionId: session.id, status: session.status },
        };
      } catch (error) {
        const code = errorCode(error);
        return {
          title: "SSH PTY failed",
          output: formatSSHError(code, hostNameFromError(error) ?? hostName, safeErrorMessage(code)),
        };
      }
    },
  });
}

function invalid(message: string, hostName?: string) {
  return {
    title: "SSH PTY failed",
    output: formatSSHError("CONFIG_INVALID", hostName, message),
  };
}

function formatPtySession(session: SSHPtySession): string {
  return `<ssh_pty id="${escapeXml(session.id)}" host="${escapeXml(session.hostName)}" connectionId="${escapeXml(session.connectionId)}" status="${escapeXml(session.status)}"></ssh_pty>`;
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
    return "SSH PTY arguments are invalid.";
  }
  if (code === "PTY_NOT_FOUND") {
    return "SSH PTY session was not found.";
  }
  if (code === "PTY_FAILED") {
    return "SSH PTY operation failed.";
  }
  return "SSH PTY operation failed.";
}

function hostNameFromError(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "hostName" in error && typeof (error as { hostName?: unknown }).hostName === "string") {
    return (error as { hostName: string }).hostName;
  }
  return undefined;
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string";
}

function isSafeErrorCode(code: string): code is "HOST_NOT_FOUND" | "CONNECT_FAILED" | "CONFIG_INVALID" | "COMMAND_FAILED" | "PTY_NOT_FOUND" | "PTY_FAILED" {
  return code === "HOST_NOT_FOUND" || code === "CONNECT_FAILED" || code === "CONFIG_INVALID" || code === "COMMAND_FAILED" || code === "PTY_NOT_FOUND" || code === "PTY_FAILED";
}
