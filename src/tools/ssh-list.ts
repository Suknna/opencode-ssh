import { tool } from "@opencode-ai/plugin";

import { escapeXml } from "../shared/errors.js";
import type { MinimalSSHManager } from "./create-tools.js";

export function createSSHListTool(manager: MinimalSSHManager) {
  return tool({
    description: "List configured SSH hosts and their current connection status.",
    args: {},
    execute: async () => ({
      title: "SSH hosts",
      output: formatSSHHosts(manager.listHosts()),
    }),
  });
}

type SSHHostForList = ReturnType<MinimalSSHManager["listHosts"]>[number];

function formatSSHHosts(hosts: SSHHostForList[]): string {
  const lines = hosts.map((host) => `  <ssh_host${formatHostAttributes(host)}></ssh_host>`);
  return ["<ssh_hosts>", ...lines, "</ssh_hosts>"].join("\n");
}

function formatHostAttributes(host: SSHHostForList): string {
  const attributes: Array<[string, string]> = [
    ["name", host.name],
    ["host", host.host],
    ["username", host.username],
    ["connected", String(host.connected)],
  ];

  if (host.description !== undefined) {
    attributes.push(["description", host.description]);
  }

  return attributes.map(([name, value]) => ` ${name}="${escapeXml(value)}"`).join("");
}
