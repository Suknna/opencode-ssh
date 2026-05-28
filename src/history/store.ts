import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export interface HistoryStoreOptions {
  projectDirectory: string;
  enabled: boolean;
  cleanupOnClose: boolean;
}

export class HistoryStore {
  constructor(private readonly options: HistoryStoreOptions) {}

  pathFor(hostName: string, connectionId: string): string {
    const rootPath = resolve(this.options.projectDirectory, ".opencode", "ssh");
    const historyPath = resolve(rootPath, safeSegment(hostName), safeSegment(connectionId));

    if (historyPath !== rootPath && !historyPath.startsWith(`${rootPath}${sep}`)) {
      throw new Error("history path escaped .opencode/ssh root");
    }

    return historyPath;
  }

  async append(hostName: string, connectionId: string, recordId: string, chunk: string): Promise<void> {
    if (!this.options.enabled) {
      return;
    }

    const historyPath = this.pathFor(hostName, connectionId);
    await mkdir(historyPath, { recursive: true });
    await writeFile(join(historyPath, `${safeSegment(recordId)}.log`), chunk, { encoding: "utf8", flag: "a" });
  }

  async read(hostName: string, connectionId: string): Promise<string> {
    if (!this.options.enabled) {
      return "";
    }

    try {
      const historyPath = this.pathFor(hostName, connectionId);
      const files = (await readdir(historyPath)).filter((file) => file.endsWith(".log")).sort();
      const chunks = await Promise.all(files.map((file) => readFile(join(historyPath, file), "utf8")));
      return chunks.join("");
    } catch (error) {
      if (isNotFoundError(error)) {
        return "";
      }
      throw error;
    }
  }

  async cleanup(hostName: string, connectionId: string): Promise<void> {
    if (!this.options.cleanupOnClose) {
      return;
    }

    await rm(this.pathFor(hostName, connectionId), { force: true, recursive: true });
  }
}

function safeSegment(value: string): string {
  const segment = value.replaceAll(/[^A-Za-z0-9._-]/g, "_");
  if (segment === "" || segment === "." || segment === "..") {
    return "_";
  }
  return segment;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
