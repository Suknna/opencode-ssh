import type { Client, ClientChannel } from "ssh2";

import type { SSHHostConfig, SSHPluginConfig } from "../config/types.js";

export type SSHConnectionStatus = "connecting" | "connected" | "closed" | "failed";

export interface SSHConnectionState {
  id: string;
  host: SSHHostConfig;
  client?: Client;
  status: SSHConnectionStatus;
  createdAt: Date;
  lastError?: Error;
}

export interface SSHCommandRecord {
  id: string;
  connectionId: string;
  hostName: string;
  command: string;
  status: SSHCommandStatus;
  startedAt: Date;
  completedAt?: Date;
  finishedAt?: Date;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export type SSHCommandStatus = "running" | "completed" | "failed" | "timeout" | "cancelled";

export type SSHPtySessionStatus = "running" | "closed" | "failed";

export interface SSHPtySession {
  id: string;
  hostName: string;
  connectionId: string;
  status: SSHPtySessionStatus;
  buffer: string[];
  bufferSize: number;
  truncated?: boolean;
  startedAt: Date;
  completedAt?: Date;
  channel: ClientChannel;
  appendChain?: Promise<void>;
  error?: string;
}

export interface SSHPtyStartOptions {
  command?: string;
  cols?: number;
  rows?: number;
  term?: string;
}

export interface SSHHistoryReadInput {
  id: string;
  offset: number;
  limit: number;
  pattern?: string;
  ignoreCase?: boolean;
}

export interface OutputPage {
  id: string;
  hostName: string;
  status: string;
  lines: string[];
  startLine?: number;
  hasMore?: boolean;
}

export interface SSHExecOptions {
  timeoutSeconds?: number;
  cwd?: string;
  env?: Record<string, string>;
  abort?: AbortSignal;
}

export interface SSHManagerOptions {
  projectDirectory: string;
  config: SSHPluginConfig;
}

export interface SSHHostSummary {
  name: string;
  host: string;
  username: string;
  connected: boolean;
  description?: string;
}

export class SSHManagerError extends Error {
  constructor(
    readonly code:
      | "HOST_NOT_FOUND"
      | "CONNECT_FAILED"
      | "CONFIG_INVALID"
      | "COMMAND_FAILED"
      | "HISTORY_NOT_FOUND"
      | "PTY_NOT_FOUND"
      | "PTY_FAILED"
      | "TRANSFER_FAILED",
    message: string,
    readonly hostName?: string,
  ) {
    super(message);
    this.name = "SSHManagerError";
  }
}
