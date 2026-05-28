import type { Client, ClientChannel, ExecOptions, SFTPWrapper } from "ssh2";

import { HistoryStore } from "../history/store.js";
import { createId } from "../shared/ids.js";
import { connectHost } from "./connection.js";
import { decodeControlSequences } from "./control.js";
import { SSHManagerError } from "./types.js";
import type {
  OutputPage,
  SSHCommandRecord,
  SSHConnectionState,
  SSHExecOptions,
  SSHHistoryReadInput,
  SSHHostSummary,
  SSHManagerOptions,
  SSHPtySession,
  SSHPtyStartOptions,
} from "./types.js";

interface PendingConnection {
  abortController: AbortController;
  promise: Promise<SSHConnectionState>;
  state: SSHConnectionState;
}

interface SSHManagerDependencies {
  connectHost(host: SSHConnectionState["host"], signal?: AbortSignal): Promise<Client>;
  maxPtyBufferChars?: number;
}

interface ActiveCommand {
  hostName: string;
  cancel(): void;
  done: Promise<void>;
}

const MAX_PTY_BUFFER_CHARS = 1_000_000;
const PTY_TRUNCATED_LINE = "[pty output truncated: oldest data discarded]";

export { SSHManagerError } from "./types.js";

export class SSHManager {
  readonly history: HistoryStore;
  private readonly connections = new Map<string, SSHConnectionState>();
  private readonly pendingConnects = new Map<string, PendingConnection>();
  private readonly commandRecords: SSHCommandRecord[] = [];
  private readonly activeCommands = new Map<string, ActiveCommand>();
  private readonly ptySessions = new Map<string, SSHPtySession>();
  private readonly connectHost: SSHManagerDependencies["connectHost"];
  private readonly maxPtyBufferChars: number;

  constructor(
    private readonly options: SSHManagerOptions,
    dependencies: SSHManagerDependencies = { connectHost },
  ) {
    this.connectHost = dependencies.connectHost;
    this.maxPtyBufferChars = dependencies.maxPtyBufferChars ?? MAX_PTY_BUFFER_CHARS;
    this.history = new HistoryStore({
      projectDirectory: options.projectDirectory,
      enabled: options.config.history.enabled,
      cleanupOnClose: options.config.history.cleanupOnClose,
    });
  }

  listHosts(): SSHHostSummary[] {
    return this.options.config.hosts.map((host) => {
      const summary: SSHHostSummary = {
        name: host.name,
        host: host.host,
        username: host.username,
        connected: this.connections.get(host.name)?.status === "connected",
      };
      if (host.description !== undefined) {
        summary.description = host.description;
      }
      return summary;
    });
  }

  listHistory(hostName?: string): SSHCommandRecord[] {
    return this.commandRecords.filter((record) => hostName === undefined || record.hostName === hostName);
  }

  readHistory(input: SSHHistoryReadInput): OutputPage {
    const record = this.commandRecords.find((candidate) => candidate.id === input.id);
    if (record === undefined) {
      throw new SSHManagerError("HISTORY_NOT_FOUND", "SSH history record was not found");
    }

    const lines = splitOutputLines(`${record.stdout ?? ""}${record.stderr ?? ""}`);
    const filteredLines = filterLines(lines, input.pattern, input.ignoreCase ?? false);
    const startIndex = Math.max(input.offset, 1) - 1;
    const limit = Math.max(input.limit, 0);
    return {
      id: record.id,
      hostName: record.hostName,
      status: record.status,
      lines: filteredLines.slice(startIndex, startIndex + limit),
      startLine: startIndex + 1,
      hasMore: startIndex + limit < filteredLines.length,
    };
  }

  async connect(hostName: string, signal?: AbortSignal): Promise<SSHConnectionState> {
    const existing = this.connections.get(hostName);
    if (existing?.status === "connected") {
      return existing;
    }

    const pending = this.pendingConnects.get(hostName);
    if (pending !== undefined) {
      return pending.promise;
    }

    const host = this.findHost(hostName);
    const abortController = new AbortController();
    const removeExternalAbort = bindAbort(signal, abortController);
    const state: SSHConnectionState = {
      id: createId("ssh_conn"),
      host,
      status: "connecting",
      createdAt: new Date(),
    };

    this.connections.set(hostName, state);

    const promise = this.connectPending(hostName, state, abortController.signal).finally(() => {
      removeExternalAbort();
      if (this.pendingConnects.get(hostName)?.promise === promise) {
        this.pendingConnects.delete(hostName);
      }
    });
    this.pendingConnects.set(hostName, { abortController, promise, state });

    return promise;
  }

  private async connectPending(
    hostName: string,
    state: SSHConnectionState,
    signal: AbortSignal,
  ): Promise<SSHConnectionState> {
    try {
      const client = await this.connectHost(state.host, signal);
      if (state.status === "closed") {
        client.end();
        client.destroy();
        throw new SSHManagerError("CONNECT_FAILED", `SSH host ${JSON.stringify(hostName)} was closed while connecting`, hostName);
      }

      state.client = client;
      state.status = "connected";
      client.once("close", () => {
        if (state.status !== "failed") {
          state.status = "closed";
        }
      });

      return state;
    } catch (error) {
      if (state.status !== "closed") {
        state.status = "failed";
        state.lastError = error instanceof Error ? error : new Error(String(error));
      }
      const message = error instanceof Error ? error.message : String(error);
      throw error instanceof SSHManagerError ? error : new SSHManagerError("CONNECT_FAILED", message, hostName);
    }
  }

  getConnection(hostName: string): SSHConnectionState {
    this.findHost(hostName);
    const state = this.connections.get(hostName);
    if (state?.status === "connected" && state.client !== undefined) {
      return state;
    }
    throw new SSHManagerError("CONNECT_FAILED", `SSH host ${JSON.stringify(hostName)} is not connected`, hostName);
  }

  async execWait(hostName: string, command: string, options: SSHExecOptions = {}): Promise<SSHCommandRecord> {
    const state = this.getConnection(hostName);
    const record = createCommandRecord(state, hostName, command);
    const completion = this.startExec(state, record, options);
    this.commandRecords.push(record);
    await completion;
    return record;
  }

  async execBackground(hostName: string, command: string, options: SSHExecOptions = {}): Promise<SSHCommandRecord> {
    const state = this.getConnection(hostName);
    const record = createCommandRecord(state, hostName, command);
    const completion = this.startExec(state, record, options);
    this.commandRecords.push(record);
    completion.catch((error: unknown) => {
      if (record.status === "running") {
        finishRecord(record, "failed", undefined, safeErrorMessage(error));
      }
    });
    return record;
  }

  async upload(hostName: string, localPath: string, remotePath: string): Promise<void> {
    const sftp = await this.openSftp(hostName);
    try {
      await runSftpTransfer(sftp.fastPut.bind(sftp), localPath, remotePath, "SFTP upload failed", hostName);
    } finally {
      closeSftp(sftp);
    }
  }

  async download(hostName: string, remotePath: string, localPath: string): Promise<void> {
    const sftp = await this.openSftp(hostName);
    try {
      await runSftpTransfer(sftp.fastGet.bind(sftp), remotePath, localPath, "SFTP download failed", hostName);
    } finally {
      closeSftp(sftp);
    }
  }

  async ptyStart(hostName: string, options: SSHPtyStartOptions = {}): Promise<SSHPtySession> {
    const state = this.getConnection(hostName);
    const client = state.client;
    if (client === undefined) {
      throw new SSHManagerError("CONNECT_FAILED", `SSH host ${JSON.stringify(hostName)} is not connected`, hostName);
    }

    return new Promise((resolve, reject) => {
      const shellOptions = {
        cols: options.cols ?? 120,
        rows: options.rows ?? 30,
        term: options.term ?? "xterm-256color",
      };
      client.shell(shellOptions, (error, channel) => {
        if (error !== undefined && error !== null) {
          reject(new SSHManagerError("PTY_FAILED", safeErrorMessage(error), hostName));
          return;
        }

        const session: SSHPtySession = {
          id: createId("ssh_pty"),
          hostName,
          connectionId: state.id,
          status: "running",
          buffer: [],
          bufferSize: 0,
          startedAt: new Date(),
          channel,
          appendChain: Promise.resolve(),
        };
        this.ptySessions.set(session.id, session);
        channel.on("data", (chunk: Buffer | string) => {
          if (session.status !== "running") {
            return;
          }
          const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
          appendPtyBuffer(session, text, this.maxPtyBufferChars);
          session.appendChain = (session.appendChain ?? Promise.resolve())
            .then(() => this.history.append(hostName, state.id, session.id, text))
            .catch(() => {});
        });
        channel.once("error", (streamError: Error) => {
          finishPtySession(session, "failed", safeErrorMessage(streamError));
        });
        channel.once("close", () => {
          finishPtySession(session, session.status === "failed" ? "failed" : "closed");
        });

        if (options.command !== undefined && options.command !== "") {
          channel.write(`${options.command}\n`);
        }
        resolve(session);
      });
    });
  }

  ptyWrite(id: string, data: string): number {
    const session = this.getPtySession(id);
    if (session.status !== "running") {
      throw new SSHManagerError("PTY_FAILED", "SSH PTY session is not running", session.hostName);
    }
    const decoded = decodeControlSequences(data);
    session.channel.write(decoded);
    return Buffer.byteLength(decoded, "utf8");
  }

  ptyRead(id: string, offset: number, limit: number): OutputPage {
    const session = this.getPtySession(id);
    const lines = splitOutputLines(session.buffer.join(""));
    const outputLines = session.truncated === true ? [PTY_TRUNCATED_LINE, ...lines] : lines;
    const startIndex = Math.max(offset, 1) - 1;
    const pageLimit = Math.max(limit, 0);
    return {
      id: session.id,
      hostName: session.hostName,
      status: session.status,
      lines: outputLines.slice(startIndex, startIndex + pageLimit),
      startLine: startIndex + 1,
      hasMore: startIndex + pageLimit < outputLines.length,
    };
  }

  ptyResize(id: string, cols: number, rows: number): SSHPtySession {
    const session = this.getPtySession(id);
    if (session.status !== "running") {
      throw new SSHManagerError("PTY_FAILED", "SSH PTY session is not running", session.hostName);
    }
    if (typeof session.channel.setWindow !== "function") {
      throw new SSHManagerError("PTY_FAILED", "SSH PTY channel does not support resize.", session.hostName);
    }
    session.channel.setWindow(rows, cols, 0, 0);
    return session;
  }

  ptyKill(id: string): SSHPtySession {
    const session = this.getPtySession(id);
    if (session.status === "running") {
      session.channel.close();
      finishPtySession(session, "closed");
    }
    return session;
  }

  async close(hostName?: string): Promise<void> {
    const entries = hostName === undefined ? [...this.connections.entries()] : [[hostName, this.getStateForClose(hostName)] as const];

    await Promise.all(entries.map(([name, state]) => this.closeConnection(name, state)));
  }

  async dispose(): Promise<void> {
    await this.close();
  }

  private findHost(hostName: string) {
    const host = this.options.config.hosts.find((candidate) => candidate.name === hostName);
    if (host === undefined) {
      throw new SSHManagerError("HOST_NOT_FOUND", `SSH host ${JSON.stringify(hostName)} is not configured`, hostName);
    }
    return host;
  }

  private getStateForClose(hostName: string): SSHConnectionState | undefined {
    this.findHost(hostName);
    return this.connections.get(hostName);
  }

  private getPtySession(id: string): SSHPtySession {
    const session = this.ptySessions.get(id);
    if (session === undefined) {
      throw new SSHManagerError("PTY_NOT_FOUND", "SSH PTY session was not found");
    }
    return session;
  }

  private async openSftp(hostName: string): Promise<SFTPWrapper> {
    const state = this.getConnection(hostName);
    const client = state.client;
    if (client === undefined) {
      throw new SSHManagerError("CONNECT_FAILED", `SSH host ${JSON.stringify(hostName)} is not connected`, hostName);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null | undefined, sftp?: SFTPWrapper) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error !== undefined && error !== null || sftp === undefined) {
          reject(new SSHManagerError("TRANSFER_FAILED", "SFTP open failed", hostName));
          return;
        }
        resolve(sftp);
      };

      try {
        client.sftp((error, sftp) => finish(error, sftp));
      } catch {
        finish(new Error("SFTP open failed"));
      }
    });
  }

  private async closeConnection(hostName: string, state: SSHConnectionState | undefined): Promise<void> {
    if (state === undefined) {
      return;
    }

    const pending = this.pendingConnects.get(hostName);
    if (pending !== undefined) {
      this.pendingConnects.delete(hostName);
      pending.abortController.abort();
    }
    const targetSessions = [...this.ptySessions.entries()].filter(([, session]) => session.hostName === hostName);
    for (const [, session] of targetSessions) {
      if (session.hostName === hostName && session.status === "running") {
        session.channel.close();
        finishPtySession(session, "closed");
      }
    }
    const commands = [...this.activeCommands.entries()].filter(([, command]) => command.hostName === hostName);
    for (const [recordId, command] of this.activeCommands.entries()) {
      if (command.hostName === hostName) {
        this.activeCommands.delete(recordId);
        command.cancel();
      }
    }
    if (state.status !== "closed") {
      state.client?.end();
    }
    state.status = "closed";
    await pending?.promise.catch(() => {});
    await Promise.all(commands.map(([, command]) => command.done.catch(() => {})));
    await Promise.all(targetSessions.map(([, session]) => (session.appendChain ?? Promise.resolve()).catch(() => {})));
    await this.history.cleanup(hostName, state.id);
    for (const [sessionId] of targetSessions) {
      this.ptySessions.delete(sessionId);
    }
    removeHistoryRecords(this.commandRecords, hostName);
  }

  private startExec(state: SSHConnectionState, record: SSHCommandRecord, options: SSHExecOptions): Promise<SSHCommandRecord> {
    const client = state.client;
    if (client === undefined) {
      throw new SSHManagerError("CONNECT_FAILED", `SSH host ${JSON.stringify(record.hostName)} is not connected`, record.hostName);
    }
    if (options.cwd !== undefined) {
      throw new SSHManagerError("CONFIG_INVALID", "cwd unsupported for now", record.hostName);
    }

    const execOptions: ExecOptions = {};
    if (options.env !== undefined) {
      execOptions.env = options.env;
    }

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    return new Promise((resolve) => {
      let settled = false;
      let channel: ClientChannel | undefined;
      let appendChain: Promise<void> = Promise.resolve();
      let historyError: string | undefined;
      let cleanupAbort = () => {};
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const appendOutput = (text: string) => {
        appendChain = appendChain
          .then(() => this.history.append(record.hostName, record.connectionId, record.id, text))
          .catch((error: unknown) => {
            historyError = safeErrorMessage(error);
          });
      };
      const finish = (status: SSHCommandRecord["status"], exitCode?: number, error?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        cleanupAbort();
        if (status === "timeout" || status === "cancelled") {
          channel?.close();
        }
        finishRecord(record, status, exitCode, error);
        appendChain.then(() => {
          if (historyError !== undefined && record.error === undefined) {
            record.error = `History append failed: ${historyError}`;
          }
          this.activeCommands.delete(record.id);
          resolveDone();
          resolve(record);
        });
      };
      cleanupAbort = bindRecordAbort(options.abort, () => finish("cancelled", undefined, "Command cancelled."));
      this.activeCommands.set(record.id, {
        hostName: record.hostName,
        cancel: () => finish("cancelled", undefined, "Command cancelled."),
        done,
      });
      if (options.abort?.aborted) {
        finish("cancelled", undefined, "Command cancelled.");
        return;
      }
      timeoutId = options.timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => finish("timeout", undefined, "Command timed out."), options.timeoutSeconds * 1000);

      client.exec(record.command, execOptions, (error, execChannel) => {
        if (error !== undefined && error !== null) {
          finish("failed", undefined, safeErrorMessage(error));
          return;
        }
        if (settled) {
          execChannel.close();
          return;
        }

        channel = execChannel;
        let exitCode: number | undefined;
        execChannel.on("data", (chunk: Buffer) => {
          if (settled || record.status !== "running") {
            return;
          }
          const text = chunk.toString("utf8");
          record.stdout = `${record.stdout ?? ""}${text}`;
          appendOutput(text);
        });
        execChannel.stderr.on("data", (chunk: Buffer) => {
          if (settled || record.status !== "running") {
            return;
          }
          const text = chunk.toString("utf8");
          record.stderr = `${record.stderr ?? ""}${text}`;
          appendOutput(text);
        });
        execChannel.once("exit", (code: number | null) => {
          exitCode = code ?? undefined;
        });
        execChannel.once("error", (streamError: Error) => {
          finish("failed", exitCode, safeErrorMessage(streamError));
        });
        execChannel.once("close", () => {
          finish(exitCode === undefined || exitCode === 0 ? "completed" : "failed", exitCode);
        });
      });
    });
  }
}

function bindAbort(signal: AbortSignal | undefined, abortController: AbortController): () => void {
  if (signal === undefined) {
    return () => {};
  }

  if (signal.aborted) {
    abortController.abort();
    return () => {};
  }

  const onAbort = () => abortController.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function bindRecordAbort(signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (signal === undefined) {
    return () => {};
  }
  if (signal.aborted) {
    return () => {};
  }

  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function createCommandRecord(state: SSHConnectionState, hostName: string, command: string): SSHCommandRecord {
  return {
    id: createId("ssh_cmd"),
    connectionId: state.id,
    hostName,
    command,
    status: "running",
    startedAt: new Date(),
    stdout: "",
    stderr: "",
  };
}

function finishRecord(
  record: SSHCommandRecord,
  status: SSHCommandRecord["status"],
  exitCode: number | undefined,
  error?: string,
): void {
  record.status = status;
  record.completedAt = new Date();
  record.finishedAt = record.completedAt;
  if (exitCode !== undefined) {
    record.exitCode = exitCode;
  }
  if (error !== undefined) {
    record.error = error;
  }
}

function finishPtySession(session: SSHPtySession, status: SSHPtySession["status"], error?: string): void {
  if (session.status !== "running" && session.completedAt !== undefined) {
    return;
  }
  session.status = status;
  session.completedAt = new Date();
  if (error !== undefined) {
    session.error = error;
  }
}

function removeHistoryRecords(records: SSHCommandRecord[], hostName: string): void {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]?.hostName === hostName) {
      records.splice(index, 1);
    }
  }
}

function appendPtyBuffer(session: SSHPtySession, text: string, maxChars: number): void {
  if (maxChars <= 0) {
    session.buffer = [];
    session.bufferSize = 0;
    session.truncated = true;
    return;
  }

  let chunk = text;
  if (chunk.length > maxChars) {
    chunk = chunk.slice(chunk.length - maxChars);
    session.truncated = true;
  }

  session.buffer.push(chunk);
  session.bufferSize += chunk.length;

  while (session.bufferSize > maxChars && session.buffer.length > 0) {
    const overflow = session.bufferSize - maxChars;
    const first = session.buffer[0] ?? "";
    session.truncated = true;
    if (first.length <= overflow) {
      session.buffer.shift();
      session.bufferSize -= first.length;
      continue;
    }
    session.buffer[0] = first.slice(overflow);
    session.bufferSize -= overflow;
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runSftpTransfer(
  transfer: (source: string, destination: string, callback: (error?: Error | null) => void) => void,
  source: string,
  destination: string,
  message: string,
  hostName: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error !== undefined && error !== null) {
        reject(new SSHManagerError("TRANSFER_FAILED", message, hostName));
        return;
      }
      resolve();
    };

    try {
      transfer(source, destination, finish);
    } catch {
      finish(new Error(message));
    }
  });
}

function closeSftp(sftp: SFTPWrapper): void {
  const end = (sftp as { end?: unknown }).end;
  if (typeof end !== "function") {
    return;
  }
  try {
    end.call(sftp);
  } catch {
    // Best-effort cleanup must not hide the transfer result.
  }
}

function splitOutputLines(output: string): string[] {
  if (output === "") {
    return [];
  }
  return output.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((line, index, lines) => line !== "" || index < lines.length - 1);
}

function filterLines(lines: string[], pattern: string | undefined, ignoreCase: boolean): string[] {
  if (pattern === undefined || pattern === "") {
    return lines;
  }

  const needle = ignoreCase ? pattern.toLocaleLowerCase() : pattern;
  return lines.filter((line) => {
    const haystack = ignoreCase ? line.toLocaleLowerCase() : line;
    return haystack.includes(needle);
  });
}
