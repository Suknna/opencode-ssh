import type { SSHHistoryConfig, SSHHostConfig, SSHHostKeyConfig, SSHPluginConfig } from "./types.js";

export class ConfigValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly source: string,
  ) {
    super(`${source}: ${code}: ${message}`);
    this.name = "ConfigValidationError";
  }
}

const DEFAULT_HISTORY: SSHHistoryConfig = {
  enabled: true,
  cleanupOnClose: true,
};

export function normalizeConfig(input: unknown, source: string): SSHPluginConfig {
  if (input === undefined || input === null) {
    return emptyConfig();
  }

  if (!isRecord(input)) {
    throw validationError("CONFIG_INVALID", "configuration must be an object", source);
  }

  const hostsInput = input.hosts ?? [];
  if (!Array.isArray(hostsInput)) {
    throw validationError("HOSTS_INVALID", "hosts must be an array", source);
  }

  return {
    hosts: hostsInput.map((hostInput, index) => normalizeHost(hostInput, index, source)),
    history: normalizeHistory(input.history, source),
  };
}

function emptyConfig(): SSHPluginConfig {
  return {
    hosts: [],
    history: { ...DEFAULT_HISTORY },
  };
}

function normalizeHost(input: unknown, index: number, source: string): SSHHostConfig {
  if (!isRecord(input)) {
    throw validationError("HOST_INVALID", `hosts[${index}] must be an object`, source);
  }

  const name = requireString(input, "name", `hosts[${index}]`, source);
  const host = requireString(input, "host", `hosts[${index}]`, source);
  const username = requireString(input, "username", `hosts[${index}]`, source);
  const port = normalizePort(input.port, `hosts[${index}]`, source);

  const password = optionalString(input, "password", `hosts[${index}]`, source);
  const passwordEnv = optionalString(input, "passwordEnv", `hosts[${index}]`, source);
  const privateKeyPath = optionalString(input, "privateKeyPath", `hosts[${index}]`, source);

  if (!password && !passwordEnv && !privateKeyPath) {
    throw validationError(
      "AUTH_MISSING",
      `hosts[${index}] must define at least one of password, passwordEnv, or privateKeyPath`,
      source,
    );
  }

  const result: SSHHostConfig = {
    name,
    host,
    port,
    username,
  };

  setOptional(result, "description", optionalString(input, "description", `hosts[${index}]`, source));
  setOptional(result, "password", password);
  setOptional(result, "passwordEnv", passwordEnv);
  setOptional(result, "privateKeyPath", privateKeyPath);
  setOptional(
    result,
    "privateKeyPassphrase",
    optionalString(input, "privateKeyPassphrase", `hosts[${index}]`, source),
  );
  setOptional(
    result,
    "privateKeyPassphraseEnv",
    optionalString(input, "privateKeyPassphraseEnv", `hosts[${index}]`, source),
  );

  const hostKey = normalizeHostKey(input.hostKey, `hosts[${index}]`, source);
  if (hostKey) {
    result.hostKey = hostKey;
  }

  return result;
}

function normalizeHistory(input: unknown, source: string): SSHHistoryConfig {
  if (input === undefined || input === null) {
    return { ...DEFAULT_HISTORY };
  }

  if (!isRecord(input)) {
    throw validationError("HISTORY_INVALID", "history must be an object", source);
  }

  return {
    enabled: optionalBoolean(input.enabled, "history.enabled", source) ?? DEFAULT_HISTORY.enabled,
    cleanupOnClose:
      optionalBoolean(input.cleanupOnClose, "history.cleanupOnClose", source) ?? DEFAULT_HISTORY.cleanupOnClose,
  };
}

function normalizeHostKey(input: unknown, path: string, source: string): SSHHostKeyConfig | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }

  if (!isRecord(input)) {
    throw validationError("HOST_KEY_INVALID", `${path}.hostKey must be an object`, source);
  }

  if (input.mode !== "accept-new" && input.mode !== "strict") {
    throw validationError("HOST_KEY_INVALID", `${path}.hostKey.mode must be accept-new or strict`, source);
  }

  const result: SSHHostKeyConfig = {
    mode: input.mode,
  };
  setOptional(result, "fingerprint", optionalString(input, "fingerprint", `${path}.hostKey`, source));
  return result;
}

function normalizePort(input: unknown, path: string, source: string): number {
  if (input === undefined || input === null) {
    return 22;
  }

  if (typeof input !== "number" || !Number.isInteger(input) || input <= 0 || input > 65535) {
    throw validationError("PORT_INVALID", `${path}.port must be an integer from 1 to 65535`, source);
  }

  return input;
}

function requireString(input: Record<string, unknown>, key: string, path: string, source: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw validationError("FIELD_REQUIRED", `${path}.${key} must be a non-empty string`, source);
  }
  return value;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
  path: string,
  source: string,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw validationError("FIELD_INVALID", `${path}.${key} must be a string`, source);
  }
  return value;
}

function optionalBoolean(input: unknown, path: string, source: string): boolean | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  if (typeof input !== "boolean") {
    throw validationError("FIELD_INVALID", `${path} must be a boolean`, source);
  }
  return input;
}

function setOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function validationError(code: string, message: string, source: string): ConfigValidationError {
  return new ConfigValidationError(code, message, source);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
