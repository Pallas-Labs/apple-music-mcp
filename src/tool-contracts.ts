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

type BaseToolDef<Input extends ToolSchema, Output extends ToolSchema> = {
  name: string;
  description: string;
  inputSchema: Input;
  outputSchema: Output;
  annotations: ToolAnnotations;
  handler: (input: ToolSchemaOutput<Input>) => Promise<ToolResult<Output>>;
};

type ReadToolDef<Input extends ToolSchema, Output extends ToolSchema> = BaseToolDef<
  Input,
  Output
> & {
  writesRequired: false;
  dryRunResult?: never;
};

type WriteToolDef<Input extends ToolSchema, Output extends ToolSchema> = BaseToolDef<
  Input,
  Output
> & {
  writesRequired: true;
  dryRunResult: (input: ToolSchemaOutput<Input>) => ToolSchemaOutput<Output>;
};

export type ToolDef<Input extends ToolSchema, Output extends ToolSchema> =
  | ReadToolDef<Input, Output>
  | WriteToolDef<Input, Output>;

export function defineTool<Input extends ToolSchema, Output extends ToolSchema>(
  definition: ToolDef<Input, Output>,
): ToolDef<Input, Output> {
  return definition;
}
