import { tool } from "@opencode-ai/plugin";

import { formatSSHOutput } from "../history/formatter.js";
import { escapeXml, formatSSHError } from "../shared/errors.js";
import type { SSHCommandRecord, SSHHistoryReadInput } from "../ssh/types.js";
import type { MinimalSSHManager } from "./create-tools.js";

const schema = tool.schema;

export function createSSHHistoryTool(manager: MinimalSSHManager) {
  return tool({
    description: "List SSH command history or read paginated command output.",
    args: {
      action: schema.enum(["list", "read"]).describe("History action to perform."),
      hostName: schema.string().optional().describe("Optional host name filter for list."),
      id: schema.string().optional().describe("Command history id to read."),
      offset: schema.number().int().min(1).optional().describe("1-based output line offset. Defaults to 1."),
      limit: schema.number().int().min(1).max(500).optional().describe("Maximum output lines to read. Defaults to 100, max 500."),
      pattern: schema.string().optional().describe("Optional substring filter applied before pagination."),
      ignoreCase: schema.boolean().optional().describe("Whether pattern matching ignores case. Defaults to false."),
    },
    execute: async ({ action, hostName, id, offset, limit, pattern, ignoreCase }) => {
      try {
        if (action === "list") {
          return {
            title: "SSH history",
            output: formatSSHHistoryList(manager.listHistory(hostName)),
          };
        }

        if (id === undefined) {
          return {
            title: "SSH history failed",
            output: formatSSHError("CONFIG_INVALID", hostName, "SSH history id is required for read."),
          };
        }

        const readInput: SSHHistoryReadInput = {
          id,
          offset: offset ?? 1,
          limit: limit ?? 100,
          ignoreCase: ignoreCase ?? false,
        };
        if (pattern !== undefined) {
          readInput.pattern = pattern;
        }

        return {
          title: "SSH history output",
          output: formatSSHOutput(manager.readHistory(readInput)),
        };
      } catch (error) {
        const code = errorCode(error);
        return {
          title: "SSH history failed",
          output: formatSSHError(code, hostNameFromError(error) ?? hostName, safeErrorMessage(code)),
        };
      }
    },
  });
}

function formatSSHHistoryList(records: SSHCommandRecord[]): string {
  const lines = records.map((record) => `  <ssh_history_record${formatRecordAttributes(record)}></ssh_history_record>`);
  return ["<ssh_history>", ...lines, "</ssh_history>"].join("\n");
}

function formatRecordAttributes(record: SSHCommandRecord): string {
  const attributes: Array<[string, string]> = [
    ["id", record.id],
    ["host", record.hostName],
    ["status", record.status],
    ["command", record.command],
  ];

  if (record.exitCode !== undefined) {
    attributes.push(["exitCode", String(record.exitCode)]);
  }

  return attributes.map(([name, value]) => ` ${name}="${escapeXml(value)}"`).join("");
}

function errorCode(error: unknown): string {
  if (isErrorWithCode(error) && (error.code === "HISTORY_NOT_FOUND" || error.code === "CONFIG_INVALID")) {
    return error.code;
  }
  return "HISTORY_NOT_FOUND";
}

function safeErrorMessage(code: string): string {
  if (code === "CONFIG_INVALID") {
    return "SSH history id is required for read.";
  }
  return "SSH history record was not found.";
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
