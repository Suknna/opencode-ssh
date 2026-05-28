import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config/loader.js";
import { normalizeConfig } from "../src/config/schema.js";

const testRoot = join(process.cwd(), ".tmp", "config-test");
const homeDirectory = join(testRoot, "home");
const projectDirectory = join(testRoot, "project");
const globalConfigPath = join(homeDirectory, ".config", "opencode", "opencode-ssh.json");
const projectConfigPath = join(projectDirectory, "opencode-ssh.json");
const originalHome = process.env.HOME;

describe("SSH configuration", () => {
  beforeEach(async () => {
    await rm(testRoot, { force: true, recursive: true });
    await mkdir(join(homeDirectory, ".config", "opencode"), { recursive: true });
    await mkdir(projectDirectory, { recursive: true });
    process.env.HOME = homeDirectory;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(testRoot, { force: true, recursive: true });
  });

  test("uses default config when input is empty", () => {
    expect(normalizeConfig(undefined, "test config")).toEqual({
      hosts: [],
      history: {
        enabled: true,
        cleanupOnClose: true,
      },
    });
  });

  test("loads default config when global and project files are missing", async () => {
    await expect(loadConfig(projectDirectory)).resolves.toEqual({
      hosts: [],
      history: {
        enabled: true,
        cleanupOnClose: true,
      },
    });
  });

  test("rejects invalid project JSON with diagnostic code and source", async () => {
    await writeFile(projectConfigPath, "{", "utf8");

    try {
      await loadConfig(projectDirectory);
      throw new Error("expected loadConfig to reject invalid JSON");
    } catch (error) {
      expect(error).toMatchObject({
        code: "JSON_INVALID",
        source: projectConfigPath,
      });
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(projectConfigPath);
      expect((error as Error).message).toMatch(/Expected|Unexpected|unterminated|parse|EOF/i);
    }
  });

  test("append merges global and project hosts", async () => {
    await writeJson(globalConfigPath, {
      hosts: [hostConfig("global", "global.example.com")],
    });
    await writeJson(projectConfigPath, {
      hosts: [hostConfig("project", "project.example.com", { port: 2200 })],
    });

    const config = await loadConfig(projectDirectory);

    expect(config.hosts.map((host) => host.name)).toEqual(["global", "project"]);
    expect(config.hosts[0]).toMatchObject({ name: "global", port: 22 });
    expect(config.hosts[1]).toMatchObject({ name: "project", port: 2200 });
  });

  test("does not load global config twice when project directory is opencode config directory", async () => {
    await writeJson(globalConfigPath, {
      hosts: [hostConfig("global", "global.example.com")],
      history: {
        enabled: false,
        cleanupOnClose: false,
      },
    });

    const config = await loadConfig(join(homeDirectory, ".config", "opencode"));

    expect(config.hosts.map((host) => host.name)).toEqual(["global"]);
    expect(config.history).toEqual({
      enabled: false,
      cleanupOnClose: false,
    });
  });

  test("rejects duplicate host names across global and project config", async () => {
    await writeJson(globalConfigPath, {
      hosts: [hostConfig("shared", "global.example.com")],
    });
    await writeJson(projectConfigPath, {
      hosts: [hostConfig("shared", "project.example.com")],
    });

    await expect(loadConfig(projectDirectory)).rejects.toMatchObject({ code: "HOST_DUPLICATE" });
  });

  test("rejects hosts without a supported auth credential", () => {
    expect(() =>
      normalizeConfig(
        {
          hosts: [
            {
              name: "missing-auth",
              host: "example.com",
              username: "root",
            },
          ],
        },
        "test config",
      ),
    ).toThrow(/AUTH_MISSING/);
  });

  test("project history explicitly overrides global history", async () => {
    await writeJson(globalConfigPath, {
      history: {
        enabled: false,
        cleanupOnClose: false,
      },
    });
    await writeJson(projectConfigPath, {
      history: {
        enabled: true,
      },
    });

    const config = await loadConfig(projectDirectory);

    expect(config.history).toEqual({
      enabled: true,
      cleanupOnClose: true,
    });
  });

  test("uses global history when project config omits history", async () => {
    await writeJson(globalConfigPath, {
      history: {
        enabled: false,
        cleanupOnClose: false,
      },
    });
    await writeJson(projectConfigPath, {
      hosts: [hostConfig("project", "project.example.com")],
    });

    const config = await loadConfig(projectDirectory);

    expect(config.history).toEqual({
      enabled: false,
      cleanupOnClose: false,
    });
  });
});

function hostConfig(name: string, host: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    host,
    username: "root",
    passwordEnv: "SSH_PASSWORD",
    ...overrides,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value), "utf8");
}
