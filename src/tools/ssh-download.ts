import { tool } from "@opencode-ai/plugin";

import { escapeXml, formatSSHError } from "../shared/errors.js";
import type { MinimalSSHManager } from "./create-tools.js";

const schema = tool.schema;

export function createSSHDownloadTool(manager: MinimalSSHManager) {
  return tool({
    description: "Download a single remote file from a connected SSH host using SFTP.",
    args: {
      hostName: schema.string().describe("Name of the connected SSH host."),
      remotePath: schema.string().describe("Remote file path to download."),
      localPath: schema.string().describe("Local destination file path."),
    },
    execute: async ({ hostName, remotePath, localPath }) => {
      try {
        await manager.download(hostName, remotePath, localPath);
        return {
          title: "SSH download completed",
          output: `<ssh_transfer direction="download" status="completed" host="${escapeXml(hostName)}" remotePath="${escapeXml(remotePath)}" localPath="${escapeXml(localPath)}"></ssh_transfer>`,
          metadata: { direction: "download", hostName, remotePath, localPath, status: "completed" },
        };
      } catch (error) {
        const code = errorCode(error);
        return {
          title: "SSH download failed",
          output: formatSSHError(code, hostName, safeErrorMessage(code)),
        };
      }
    },
  });
}

function errorCode(error: unknown): string {
  if (isErrorWithCode(error)) {
    return isSafeErrorCode(error.code) ? error.code : "TRANSFER_FAILED";
  }
  return "TRANSFER_FAILED";
}

function safeErrorMessage(code: string): string {
  if (code === "HOST_NOT_FOUND") {
    return "SSH host is not configured.";
  }
  if (code === "CONNECT_FAILED") {
    return "SSH host is not connected.";
  }
  return "SSH download failed.";
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string";
}

function isSafeErrorCode(code: string): code is "HOST_NOT_FOUND" | "CONNECT_FAILED" | "TRANSFER_FAILED" {
  return code === "HOST_NOT_FOUND" || code === "CONNECT_FAILED" || code === "TRANSFER_FAILED";
}
