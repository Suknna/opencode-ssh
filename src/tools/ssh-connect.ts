import { tool } from "@opencode-ai/plugin";

import { escapeXml, formatSSHError } from "../shared/errors.js";
import type { MinimalSSHManager } from "./create-tools.js";

const schema = tool.schema;
const defaultTimeoutSeconds = 30;

export function createSSHConnectTool(manager: MinimalSSHManager) {
  return tool({
    description: "Connect to a configured SSH host by name.",
    args: {
      hostName: schema.string().describe("Name of the configured SSH host to connect to."),
      timeoutSeconds: schema
        .number()
        .int()
        .positive()
        .max(120)
        .optional()
        .describe("Optional positive connection timeout in seconds, up to 120."),
    },
    execute: async ({ hostName, timeoutSeconds }, context) => {
      const timeout = timeoutSeconds ?? defaultTimeoutSeconds;
      const abortController = new AbortController();
      const cleanupAbort = bindAbort(context.abort, abortController);
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, timeout * 1000);

      try {
        const state = await manager.connect(hostName, abortController.signal);
        return {
          title: "SSH connected",
          output: `<ssh_connected host="${escapeXml(hostName)}" connectionId="${escapeXml(state.id)}"></ssh_connected>`,
          metadata: { hostName, connectionId: state.id },
        };
      } catch (error) {
        const code = timedOut ? "CONNECT_TIMEOUT" : errorCode(error);
        return {
          title: "SSH connect failed",
          output: formatSSHError(code, hostName, safeErrorMessage(code)),
        };
      } finally {
        clearTimeout(timeoutId);
        cleanupAbort();
      }
    },
  });
}

function bindAbort(signal: AbortSignal, abortController: AbortController): () => void {
  if (signal.aborted) {
    abortController.abort();
    return () => {};
  }

  const onAbort = () => abortController.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function errorCode(error: unknown): string {
  if (isErrorWithCode(error) && (error.code === "HOST_NOT_FOUND" || error.code === "CONNECT_FAILED")) {
    return error.code;
  }
  return "CONNECT_FAILED";
}

function safeErrorMessage(code: string): string {
  if (code === "HOST_NOT_FOUND") {
    return "SSH host is not configured.";
  }
  if (code === "CONNECT_TIMEOUT") {
    return "SSH connection timed out.";
  }
  return "SSH connection failed.";
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string";
}
