import type {
  InputRequiredResult,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";

import type { RuntimeConfig } from "./config.js";
import type { DiagnosticData } from "./types.js";

export const READ_ONLY_ANNOTATIONS = Object.freeze({
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
} satisfies ToolAnnotations);

export const ADDITIVE_WRITE_ANNOTATIONS = Object.freeze({
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  readOnlyHint: false,
} satisfies ToolAnnotations);

export const IDEMPOTENT_WRITE_ANNOTATIONS = Object.freeze({
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: false,
} satisfies ToolAnnotations);

export const DESTRUCTIVE_WRITE_ANNOTATIONS = Object.freeze({
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: false,
} satisfies ToolAnnotations);

export type ToolSchema = StandardSchemaWithJSON;

export type ToolSchemaOutput<S extends ToolSchema> =
  StandardSchemaWithJSON.InferOutput<S>;

export interface ToolResult<Output extends ToolSchema> {
  structuredContent: ToolSchemaOutput<Output>;
  logData?: DiagnosticData;
}

export interface ToolContext {
  canElicit: boolean;
  /** Client responses to the input requests that an earlier round of this call returned. */
  inputResponses: ServerContext["mcpReq"]["inputResponses"];
  /** The configuration the server was created with. */
  config: RuntimeConfig;
  /** Names of the tools the server registered, in registration order. */
  toolNames: readonly string[];
}

interface BaseToolDef<
  Input extends ToolSchema,
  Output extends ToolSchema,
  Args,
> {
  name: string;
  description: string;
  inputSchema: Input;
  outputSchema: Output;
  annotations: ToolAnnotations;
  handler: (
    input: Args,
    context: ToolContext
  ) => Promise<ToolResult<Output> | InputRequiredResult>;
}

type ReadToolDef<
  Input extends ToolSchema,
  Output extends ToolSchema,
  Args,
> = BaseToolDef<Input, Output, Args> & {
  writesRequired: false;
  dryRunResult?: never;
};

type WriteToolDef<
  Input extends ToolSchema,
  Output extends ToolSchema,
  Args,
> = BaseToolDef<Input, Output, Args> & {
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

/** Code that needs a tool's schema types, such as its registration with the SDK. */
export type ToolUser<R> = <Input extends ToolSchema, Output extends ToolSchema>(
  tool: ToolDef<Input, Output>
) => R;

export interface TypedTool {
  /** Passes the tool to `use` with its schema types intact. */
  withTypes: <R>(use: ToolUser<R>) => R;
}

/**
 * A tool with its schema types erased, so tools with different schemas share one array.
 * Its handlers accept `never`; call them through `withTypes`, which restores the schema types.
 */
export type AnyToolDef = ToolDef<ToolSchema, ToolSchema, never> & TypedTool;

export const defineTool = <Input extends ToolSchema, Output extends ToolSchema>(
  definition: ToolDef<Input, Output>
): ToolDef<Input, Output> & TypedTool => ({
  ...definition,
  withTypes: (use) => use(definition),
});
