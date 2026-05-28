import { tool } from "@opencode-ai/plugin";

import { escapeXml, formatSSHError } from "../shared/errors.js";
import type { MinimalSSHManager } from "./create-tools.js";

const schema = tool.schema;

export function createSSHCloseTool(manager: MinimalSSHManager) {
  return tool({
    description: "Close one configured SSH host connection, or all SSH connections when hostName is omitted.",
    args: {
      hostName: schema.string().optional().describe("Optional configured SSH host name to close. Omit to close all hosts."),
    },
    execute: async ({ hostName }) => {
      try {
        await manager.close(hostName);
        const host = hostName ?? "all";
        return {
          title: "SSH closed",
          output: `<ssh_closed host="${escapeXml(host)}"></ssh_closed>`,
          metadata: hostName === undefined ? { all: true } : { hostName },
        };
      } catch (error) {
        const code = errorCode(error);
        return {
          title: "SSH close failed",
          output: formatSSHError(code, hostName, safeErrorMessage(code)),
        };
      }
    },
  });
}

function errorCode(error: unknown): string {
  if (isErrorWithCode(error) && (error.code === "HOST_NOT_FOUND" || error.code === "CONNECT_FAILED")) {
    return error.code;
  }
  return "CLOSE_FAILED";
}

function safeErrorMessage(code: string): string {
  if (code === "HOST_NOT_FOUND") {
    return "SSH host is not configured.";
  }
  if (code === "CONNECT_FAILED") {
    return "SSH host is not connected.";
  }
  return "SSH close failed.";
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string";
}
