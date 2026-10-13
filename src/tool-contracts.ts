import type {
  InputRequiredResult,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";

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

export const IDEMPOTENT_WRITE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} satisfies ToolAnnotations);

export const DESTRUCTIVE_WRITE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} satisfies ToolAnnotations);

export type ToolSchema = StandardSchemaWithJSON;

export type ToolSchemaOutput<S extends ToolSchema> = StandardSchemaWithJSON.InferOutput<S>;

export type ToolResult<Output extends ToolSchema> = {
  structuredContent: ToolSchemaOutput<Output>;
  logData?: Record<string, unknown>;
};

export type ToolContext = {
  canElicit: boolean;
  /** Client responses to the input requests that an earlier round of this call returned. */
  inputResponses: Record<string, unknown> | undefined;
};

type BaseToolDef<Input extends ToolSchema, Output extends ToolSchema, Args> = {
  name: string;
  description: string;
  inputSchema: Input;
  outputSchema: Output;
  annotations: ToolAnnotations;
  handler: (input: Args, context: ToolContext) => Promise<ToolResult<Output> | InputRequiredResult>;
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
  /**
   * How much of the call holds the mutation lock. "call" (the default) locks the whole handler.
   * "handler" leaves locking to the handler, which wraps only its mutating steps in
   * withMutationLock so slow reads do not block other writes.
   */
  lock?: "call" | "handler";
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
