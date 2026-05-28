export function formatSSHError(code: string, hostName: string | undefined, message: string): string {
  const hostAttribute = hostName === undefined ? "" : ` host="${escapeXml(hostName)}"`;
  return `<ssh_error code="${escapeXml(code)}"${hostAttribute}>${escapeXml(message)}</ssh_error>`;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
