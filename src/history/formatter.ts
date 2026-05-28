import { escapeXml } from "../shared/errors.js";
import type { OutputPage } from "../ssh/types.js";

const MAX_LINE_LENGTH = 2000;
const TRUNCATED_MARKER = "…[truncated]";

export function formatSSHOutput(page: OutputPage): string {
  const startLine = page.startLine ?? 1;
  const lines = page.lines.map((line, index) => `${formatLineNumber(startLine + index)}| ${escapeXml(truncateLine(line))}`);
  const body = [...lines];

  if (page.hasMore === true) {
    body.push("<ssh_more>true</ssh_more>");
  }

  return [
    `<ssh_output id="${escapeXml(page.id)}" host="${escapeXml(page.hostName)}" status="${escapeXml(page.status)}">`,
    ...body,
    "</ssh_output>",
  ].join("\n");
}

function formatLineNumber(lineNumber: number): string {
  return lineNumber.toString().padStart(5, "0");
}

function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) {
    return line;
  }
  return `${line.slice(0, MAX_LINE_LENGTH)}${TRUNCATED_MARKER}`;
}
