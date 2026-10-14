/** Escape a string for safe interpolation into AppleScript source code. */
export function escapeAppleScriptString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

/**
 * Serialize a value as a single-line JavaScript literal for JXA source. JSON.stringify escapes
 * quotes, backslashes, and control characters but leaves the U+2028/U+2029 line terminators raw.
 */
export function toJavaScriptLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
