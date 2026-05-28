export interface SSHHostKeyConfig {
  mode: "accept-new" | "strict";
  fingerprint?: string;
}

export interface SSHHostConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  description?: string;
  password?: string;
  passwordEnv?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  privateKeyPassphraseEnv?: string;
  hostKey?: SSHHostKeyConfig;
}

export interface SSHHistoryConfig {
  enabled: boolean;
  cleanupOnClose: boolean;
}

export interface SSHPluginConfig {
  hosts: SSHHostConfig[];
  history: SSHHistoryConfig;
}
