import type { ToolDefinition } from "@opencode-ai/plugin";

import { createSSHCloseTool } from "./ssh-close.js";
import { createSSHConnectTool } from "./ssh-connect.js";
import { createSSHDownloadTool } from "./ssh-download.js";
import { createSSHExecTool } from "./ssh-exec.js";
import { createSSHHistoryTool } from "./ssh-history.js";
import { createSSHListTool } from "./ssh-list.js";
import { createSSHPtyTool } from "./ssh-pty.js";
import { createSSHUploadTool } from "./ssh-upload.js";
import type {
  OutputPage,
  SSHCommandRecord,
  SSHConnectionState,
  SSHExecOptions,
  SSHHistoryReadInput,
  SSHHostSummary,
  SSHPtySession,
  SSHPtyStartOptions,
} from "../ssh/types.js";

export interface MinimalSSHManager {
  listHosts(): SSHHostSummary[];
  connect(hostName: string, signal?: AbortSignal): Promise<SSHConnectionState>;
  execWait(hostName: string, command: string, options?: SSHExecOptions): Promise<SSHCommandRecord>;
  execBackground(hostName: string, command: string, options?: SSHExecOptions): Promise<SSHCommandRecord>;
  upload(hostName: string, localPath: string, remotePath: string): Promise<void>;
  download(hostName: string, remotePath: string, localPath: string): Promise<void>;
  ptyStart(hostName: string, options?: SSHPtyStartOptions): Promise<SSHPtySession>;
  ptyWrite(id: string, data: string): number;
  ptyRead(id: string, offset: number, limit: number): OutputPage;
  ptyResize(id: string, cols: number, rows: number): SSHPtySession;
  ptyKill(id: string): SSHPtySession;
  listHistory(hostName?: string): SSHCommandRecord[];
  readHistory(input: SSHHistoryReadInput): OutputPage;
  close(hostName?: string): Promise<void>;
  dispose(): Promise<void>;
}

export function createSSHTools(manager: MinimalSSHManager): Record<string, ToolDefinition> {
  return {
    ssh_list: createSSHListTool(manager),
    ssh_connect: createSSHConnectTool(manager),
    ssh_exec: createSSHExecTool(manager),
    ssh_pty: createSSHPtyTool(manager),
    ssh_history: createSSHHistoryTool(manager),
    ssh_upload: createSSHUploadTool(manager),
    ssh_download: createSSHDownloadTool(manager),
    ssh_close: createSSHCloseTool(manager),
  };
}
