import type * as z from "zod/v4";

import { MusicToolError } from "../types.js";

export function parseAppleScriptJson<Schema extends z.ZodType>(
  stdout: string,
  schema: Schema,
  invalidPayloadMessage: string
): z.output<Schema> {
  try {
    return schema.parse(JSON.parse(stdout));
  } catch {
    throw new MusicToolError("script_error", invalidPayloadMessage, {
      outputLength: stdout.length,
    });
  }
}
