import { describe, expect, test } from "bun:test";

import { formatSSHOutput } from "../src/history/formatter.js";
import { createId } from "../src/shared/ids.js";
import { formatSSHError } from "../src/shared/errors.js";

describe("formatSSHOutput", () => {
  test("formats output tag attributes and numbered lines", () => {
    const output = formatSSHOutput({
      id: "rec-1",
      hostName: "prod",
      status: "running",
      startLine: 2,
      lines: ["alpha", "beta"],
    });

    expect(output).toContain('<ssh_output id="rec-1" host="prod" status="running">');
    expect(output).toContain("00002| alpha");
    expect(output).toContain("00003| beta");
    expect(output).toContain("</ssh_output>");
  });

  test("escapes XML in attributes and line content", () => {
    const output = formatSSHOutput({
      id: 'id&"',
      hostName: "a<b>",
      status: 'done"',
      lines: ['<&>"'],
    });

    expect(output).toContain('id="id&amp;&quot;"');
    expect(output).toContain('host="a&lt;b&gt;"');
    expect(output).toContain('status="done&quot;"');
    expect(output).toContain("00001| &lt;&amp;&gt;&quot;");
  });

  test("truncates lines longer than 2000 characters", () => {
    const output = formatSSHOutput({
      id: "rec-1",
      hostName: "prod",
      status: "done",
      lines: [`${"x".repeat(2000)}tail`],
    });

    expect(output).toContain(`00001| ${"x".repeat(2000)}…[truncated]\n`);
    expect(output).not.toContain("tail");
  });

  test("includes ssh_more when more output is available", () => {
    const output = formatSSHOutput({
      id: "rec-1",
      hostName: "prod",
      status: "running",
      lines: [],
      hasMore: true,
    });

    expect(output).toContain("<ssh_more>true</ssh_more>");
  });
});

describe("shared formatters", () => {
  test("formats SSH errors with escaped XML", () => {
    expect(formatSSHError('E&"', "a<b>", '<bad>&"')).toBe(
      '<ssh_error code="E&amp;&quot;" host="a&lt;b&gt;">&lt;bad&gt;&amp;&quot;</ssh_error>',
    );
  });

  test("omits SSH error host attribute when host name is not provided", () => {
    expect(formatSSHError("E", undefined, "bad")).toBe('<ssh_error code="E">bad</ssh_error>');
  });

  test("creates unique IDs with the requested prefix", () => {
    const first = createId("ssh");
    const second = createId("ssh");

    expect(first.startsWith("ssh_")).toBe(true);
    expect(second.startsWith("ssh_")).toBe(true);
    expect(first).not.toBe(second);
  });
});
