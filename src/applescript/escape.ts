/** Escape a string for safe interpolation into AppleScript source code. */
export const escapeAppleScriptString = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Serialize a value as a single-line JavaScript literal for JXA source. JSON.stringify escapes
 * quotes, backslashes, and control characters but leaves the U+2028/U+2029 line terminators raw.
 */
export const toJavaScriptLiteral = (value: JsonValue): string =>
  JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
