import { tool } from "@opencode-ai/plugin";

import { escapeXml, formatSSHError } from "../shared/errors.js";
import type { MinimalSSHManager } from "./create-tools.js";

const schema = tool.schema;

export function createSSHUploadTool(manager: MinimalSSHManager) {
  return tool({
    description: "Upload a single local file to a connected SSH host using SFTP.",
    args: {
      hostName: schema.string().describe("Name of the connected SSH host."),
      localPath: schema.string().describe("Local file path to upload."),
      remotePath: schema.string().describe("Remote destination file path."),
    },
    execute: async ({ hostName, localPath, remotePath }) => {
      try {
        await manager.upload(hostName, localPath, remotePath);
        return {
          title: "SSH upload completed",
          output: `<ssh_transfer direction="upload" status="completed" host="${escapeXml(hostName)}" localPath="${escapeXml(localPath)}" remotePath="${escapeXml(remotePath)}"></ssh_transfer>`,
          metadata: { direction: "upload", hostName, localPath, remotePath, status: "completed" },
        };
      } catch (error) {
        const code = errorCode(error);
        return {
          title: "SSH upload failed",
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
  return "SSH upload failed.";
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string";
}

function isSafeErrorCode(code: string): code is "HOST_NOT_FOUND" | "CONNECT_FAILED" | "TRANSFER_FAILED" {
  return code === "HOST_NOT_FOUND" || code === "CONNECT_FAILED" || code === "TRANSFER_FAILED";
}
