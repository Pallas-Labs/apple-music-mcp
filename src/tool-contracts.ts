import type { StandardSchemaWithJSON, ToolAnnotations } from "@modelcontextprotocol/server";

export const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} satisfies ToolAnnotations);

export const ADDITIVE_WRITE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} satisfies ToolAnnotations);

export type ToolSchema = StandardSchemaWithJSON;

export type ToolSchemaOutput<S extends ToolSchema> = StandardSchemaWithJSON.InferOutput<S>;

export type ToolResult<Output extends ToolSchema> = {
  structuredContent: ToolSchemaOutput<Output>;
  logData?: Record<string, unknown>;
};

type BaseToolDef<Input extends ToolSchema, Output extends ToolSchema, Args> = {
  name: string;
  description: string;
  inputSchema: Input;
  outputSchema: Output;
  annotations: ToolAnnotations;
  handler: (input: Args) => Promise<ToolResult<Output>>;
};

type ReadToolDef<Input extends ToolSchema, Output extends ToolSchema, Args> = BaseToolDef<
  Input,
  Output,
  Args
> & {
  writesRequired: false;
  dryRunResult?: never;
};

type WriteToolDef<Input extends ToolSchema, Output extends ToolSchema, Args> = BaseToolDef<
  Input,
  Output,
  Args
> & {
  writesRequired: true;
  dryRunResult: (input: Args) => ToolSchemaOutput<Output>;
};

export type ToolDef<
  Input extends ToolSchema,
  Output extends ToolSchema,
  Args = ToolSchemaOutput<Input>,
> = ReadToolDef<Input, Output, Args> | WriteToolDef<Input, Output, Args>;

/**
 * A tool with its schema types erased, so tools with different schemas share one array.
 * Its handlers accept `never`: only the registration callback may call them, because the SDK
 * has already parsed the arguments with the same tool's `inputSchema`.
 */
export type AnyToolDef = ToolDef<ToolSchema, ToolSchema, never>;

export function defineTool<Input extends ToolSchema, Output extends ToolSchema>(
  definition: ToolDef<Input, Output>,
): ToolDef<Input, Output> {
  return definition;
}
