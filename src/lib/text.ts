const HTML_TAG_RE = /<[^>]+>/g;
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function sanitizePlainText(input: string): string {
  return input
    .replace(CONTROL_CHAR_RE, " ")
    .replace(HTML_TAG_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}
