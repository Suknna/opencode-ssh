import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeConfig } from "./schema.js";
import type { SSHPluginConfig } from "./types.js";

const CONFIG_FILE_NAME = "opencode-ssh.json";

interface LoadedConfig {
  config: SSHPluginConfig;
  hasHistory: boolean;
}

export class ConfigLoadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly source: string,
  ) {
    super(`${source}: ${code}: ${message}`);
    this.name = "ConfigLoadError";
  }
}

export async function loadConfig(projectDirectory: string): Promise<SSHPluginConfig> {
  const globalPath = join(homeDirectory(), ".config", "opencode", CONFIG_FILE_NAME);
  const projectPath = join(projectDirectory, CONFIG_FILE_NAME);

  const [globalConfig, projectConfig] = await Promise.all([
    loadConfigFile(globalPath),
    loadConfigFile(projectPath),
  ]);

  return mergeConfigs(globalConfig, projectConfig);
}

export function mergeConfigs(globalConfig: LoadedConfig, projectConfig: LoadedConfig): SSHPluginConfig {
  const seenNames = new Set<string>();
  const hosts = [];

  for (const host of [...globalConfig.config.hosts, ...projectConfig.config.hosts]) {
    if (seenNames.has(host.name)) {
      throw new ConfigLoadError("HOST_DUPLICATE", `host name ${JSON.stringify(host.name)} is defined more than once`, "merged config");
    }
    seenNames.add(host.name);
    hosts.push(host);
  }

  return {
    hosts,
    history: projectConfig.hasHistory ? projectConfig.config.history : globalConfig.config.history,
  };
}

async function loadConfigFile(filePath: string): Promise<LoadedConfig> {
  const raw = await readOptionalFile(filePath);
  if (raw === undefined) {
    return {
      config: normalizeConfig(undefined, filePath),
      hasHistory: false,
    };
  }

  const parsed = parseJson(raw, filePath);
  return {
    config: normalizeConfig(parsed, filePath),
    hasHistory: hasExplicitHistory(parsed),
  };
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function parseJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new ConfigLoadError("JSON_INVALID", message, source);
  }
}

function hasExplicitHistory(input: unknown): boolean {
  return isRecord(input) && Object.hasOwn(input, "history");
}

function homeDirectory(): string {
  const home = process.env.HOME;
  if (!home) {
    throw new ConfigLoadError("HOME_MISSING", "HOME environment variable is not set", "global config");
  }
  return home;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const configFileName = CONFIG_FILE_NAME;
