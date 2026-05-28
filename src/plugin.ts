import type { Plugin } from "@opencode-ai/plugin";

import { loadConfig } from "./config/loader.js";
import { SSHManager } from "./ssh/manager.js";
import { createSSHTools } from "./tools/create-tools.js";

export const createSSHPlugin: Plugin = async (ctx) => {
  const config = await loadConfig(ctx.directory);
  const manager = new SSHManager({ projectDirectory: ctx.directory, config });

  return {
    tool: createSSHTools(manager),
    dispose: async () => {
      await manager.dispose();
    },
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        await manager.dispose();
      }
    },
  };
};
