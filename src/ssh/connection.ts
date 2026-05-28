import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Client, type ConnectConfig } from "ssh2";

import type { SSHHostConfig } from "../config/types.js";

const DEFAULT_READY_TIMEOUT_MS = 20_000;

export async function connectHost(host: SSHHostConfig, signal?: AbortSignal): Promise<Client> {
  if (host.hostKey?.mode === "strict") {
    throw new Error(`strict host key verification is not supported for SSH host ${JSON.stringify(host.name)}`);
  }

  const client = new Client();
  const config = await createConnectConfig(host);

  if (signal?.aborted) {
    client.destroy();
    throw abortError();
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      client.off("ready", onReady);
      client.off("error", onError);
      client.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };

    const settleResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(client);
    };

    const settleReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      client.destroy();
      reject(error);
    };

    const onReady = () => settleResolve();
    const onError = (error: Error) => settleReject(error);
    const onClose = () => settleReject(new Error(`SSH connection closed before ready for host ${JSON.stringify(host.name)}`));
    const onAbort = () => settleReject(abortError());

    client.once("ready", onReady);
    client.once("error", onError);
    client.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      client.connect(config);
    } catch (error) {
      settleReject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function createConnectConfig(host: SSHHostConfig): Promise<ConnectConfig> {
  const config: ConnectConfig = {
    host: host.host,
    port: host.port,
    readyTimeout: DEFAULT_READY_TIMEOUT_MS,
    username: host.username,
  };

  const password = secretFromEnv(host.passwordEnv) ?? host.password;
  if (password !== undefined) {
    config.password = password;
  }

  if (host.privateKeyPath !== undefined) {
    config.privateKey = await readFile(expandHome(host.privateKeyPath), "utf8");
  }

  const passphrase = secretFromEnv(host.privateKeyPassphraseEnv) ?? host.privateKeyPassphrase;
  if (passphrase !== undefined) {
    config.passphrase = passphrase;
  }

  return config;
}

function secretFromEnv(name: string | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  return process.env[name];
}

function expandHome(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }
  if (filePath.startsWith("~/")) {
    return join(homedir(), filePath.slice(2));
  }
  return filePath;
}

function abortError(): Error {
  return new Error("SSH connection aborted");
}
