import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Type } from "typebox";
import type {
  ExternalToolDefinition,
  ExternalToolResult,
  ProviderAbortSignal,
  ProviderContext,
} from "@contracts/provider";
import { externalToolResultText, externalToolSdkName, piExternalToolSdkName, validateExternalToolResultEnvelope } from "./nativeToolProtocol.js";

type JsonSchema = Record<string, unknown>;

function schemaOptions(schema: JsonSchema): Record<string, unknown> {
  return {
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    ...(typeof schema.title === "string" ? { title: schema.title } : {}),
    ...(typeof schema.minLength === "number" ? { minLength: schema.minLength } : {}),
    ...(typeof schema.maxLength === "number" ? { maxLength: schema.maxLength } : {}),
    ...(typeof schema.minItems === "number" ? { minItems: schema.minItems } : {}),
    ...(typeof schema.maxItems === "number" ? { maxItems: schema.maxItems } : {}),
    ...(typeof schema.minimum === "number" ? { minimum: schema.minimum } : {}),
    ...(typeof schema.maximum === "number" ? { maximum: schema.maximum } : {}),
    ...(typeof schema.exclusiveMinimum === "number" ? { exclusiveMinimum: schema.exclusiveMinimum } : {}),
    ...(typeof schema.exclusiveMaximum === "number" ? { exclusiveMaximum: schema.exclusiveMaximum } : {}),
  };
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function literalUnion(values: unknown[]): z.ZodTypeAny {
  const literals = values.map((value) => z.literal(value as string | number | boolean | null));
  if (literals.length === 1) return literals[0]!;
  return z.union(literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

function withDescription<T extends z.ZodTypeAny>(converted: T, schema: JsonSchema): T {
  return typeof schema.description === "string" ? converted.describe(schema.description) as T : converted;
}

/** Convert the supported, validated JSON Schema subset into a Zod schema for Claude's native MCP server. */
function toZodSchema(schema: JsonSchema): z.ZodTypeAny {
  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    return withDescription(z.literal(schema.const as string | number | boolean | null), schema);
  }
  if (Array.isArray(schema.enum)) return withDescription(literalUnion(schema.enum), schema);
  switch (schema.type) {
    case "string": {
      let out = z.string();
      if (typeof schema.minLength === "number") out = out.min(schema.minLength);
      if (typeof schema.maxLength === "number") out = out.max(schema.maxLength);
      return withDescription(out, schema);
    }
    case "number":
    case "integer": {
      let out = z.number().finite();
      if (schema.type === "integer") out = out.int();
      if (typeof schema.minimum === "number") out = out.min(schema.minimum);
      if (typeof schema.maximum === "number") out = out.max(schema.maximum);
      if (typeof schema.exclusiveMinimum === "number") out = out.gt(schema.exclusiveMinimum);
      if (typeof schema.exclusiveMaximum === "number") out = out.lt(schema.exclusiveMaximum);
      return withDescription(out, schema);
    }
    case "boolean": return withDescription(z.boolean(), schema);
    case "null": return withDescription(z.null(), schema);
    case "array": {
      let out = z.array(toZodSchema(schema.items as JsonSchema));
      if (typeof schema.minItems === "number") out = out.min(schema.minItems);
      if (typeof schema.maxItems === "number") out = out.max(schema.maxItems);
      return withDescription(out, schema);
    }
    case "object": {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, child] of Object.entries(properties)) {
        if (!isRecord(child)) throw new Error(`Invalid property schema: ${key}`);
        const converted = toZodSchema(child);
        shape[key] = required.has(key) ? converted : converted.optional();
      }
      const object = z.object(shape);
      return withDescription(schema.additionalProperties === false ? object.strict() : object.passthrough(), schema);
    }
    default:
      throw new Error(`Unsupported JSON Schema type for Claude: ${String(schema.type)}`);
  }
}

/** Claude's SDK accepts a Zod raw object shape for native in-process MCP tools. */
export function jsonSchemaToZodShape(schema: JsonSchema): Record<string, z.ZodTypeAny> {
  if (schema.type !== "object") throw new Error("Claude external tools require an object input schema");
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, child] of Object.entries(properties)) {
    if (!isRecord(child)) throw new Error(`Invalid property schema: ${key}`);
    const converted = toZodSchema(child);
    shape[key] = required.has(key) ? converted : converted.optional();
  }
  return shape;
}

function typeBoxLiteral(value: unknown, options: Record<string, unknown> = {}): unknown {
  return value === null
    ? Type.Null(options)
    : Type.Literal(value as string | number | boolean, options);
}

/** Convert the supported JSON Schema subset to TypeBox's native schema objects for Pi. */
export function jsonSchemaToTypeBox(schema: JsonSchema): unknown {
  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    return typeBoxLiteral(schema.const, schemaOptions(schema));
  }
  if (Array.isArray(schema.enum)) {
    const literals = schema.enum.map((value) => typeBoxLiteral(value));
    return literals.length === 1 ? literals[0] : Type.Union(literals as never, schemaOptions(schema));
  }
  const options = schemaOptions(schema);
  switch (schema.type) {
    case "string": return Type.String(options);
    case "number": return Type.Number(options);
    case "integer": return Type.Integer(options);
    case "boolean": return Type.Boolean(options);
    case "null": return Type.Null(options);
    case "array": return Type.Array(jsonSchemaToTypeBox(schema.items as JsonSchema) as never, options);
    case "object": {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
      const shape: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(properties)) {
        if (!isRecord(child)) throw new Error(`Invalid property schema: ${key}`);
        const converted = jsonSchemaToTypeBox(child);
        shape[key] = required.has(key) ? converted : Type.Optional(converted as never);
      }
      return Type.Object(shape as never, {
        ...options,
        additionalProperties: schema.additionalProperties !== false,
      });
    }
    default:
      throw new Error(`Unsupported JSON Schema type for Pi: ${String(schema.type)}`);
  }
}

function resultText(result: ExternalToolResult): string {
  if (result.status === "success") {
    if (typeof result.result === "string") return result.result;
    try { return JSON.stringify(result.result); } catch { return "External tool returned a non-serializable result."; }
  }
  return result.error || (result.status === "cancelled" ? "External tool call was cancelled." : "External tool call failed.");
}

/** Build Claude's in-process MCP tool definitions; each handler returns to the same query turn. */
export function buildClaudeExternalSdkTools(
  tools: ExternalToolDefinition[],
  sessionId: string,
  invokeExternalTool: ProviderContext["invokeExternalTool"],
  turnSignal: ProviderAbortSignal,
): Array<Record<string, unknown>> {
  return tools.map((definition) => ({
    name: externalToolSdkName(definition.name),
    description: definition.description,
    inputSchema: jsonSchemaToZodShape(definition.inputSchema),
    handler: async (args: Record<string, unknown>) => {
      const callId = randomUUID();
      let result: ExternalToolResult;
      if (!invokeExternalTool) {
        result = { sessionId, callId, status: "error", error: "unsupported: no host external-tool callback is connected" };
      } else {
        try {
          result = validateExternalToolResultEnvelope(await invokeExternalTool({
            sessionId,
            callId,
            name: definition.name,
            input: args,
          }, turnSignal), sessionId, callId);
        } catch (error) {
          result = { sessionId, callId, status: "error", error: error instanceof Error ? error.message : String(error) };
        }
      }
      return {
        content: [{ type: "text" as const, text: externalToolResultText(result) }],
        isError: result.status !== "success",
      };
    },
  }));
}

/** Build Pi customTools using its native ToolDefinition.execute callback. */
export function buildPiExternalTools(
  tools: ExternalToolDefinition[],
  sessionId: string,
  invokeExternalTool: ProviderContext["invokeExternalTool"],
  turnSignal: ProviderAbortSignal,
): Array<Record<string, unknown>> {
  return tools.map((definition) => ({
    name: piExternalToolSdkName(definition.name),
    label: definition.name,
    description: definition.description,
    promptSnippet: definition.description,
    parameters: jsonSchemaToTypeBox(definition.inputSchema),
    executionMode: "sequential",
    execute: async (
      toolCallId: string,
      params: unknown,
      callSignal?: ProviderAbortSignal,
    ) => {
      let result: ExternalToolResult;
      if (!invokeExternalTool) {
        result = { sessionId, callId: toolCallId, status: "error", error: "unsupported: no host external-tool callback is connected" };
      } else {
        try {
          result = validateExternalToolResultEnvelope(await invokeExternalTool({
            sessionId,
            callId: toolCallId,
            name: definition.name,
            input: params,
          }, callSignal ?? turnSignal), sessionId, toolCallId);
        } catch (error) {
          result = { sessionId, callId: toolCallId, status: "error", error: error instanceof Error ? error.message : String(error) };
        }
      }
      return {
        content: [{ type: "text" as const, text: resultText(result) }],
        isError: result.status !== "success",
      };
    },
  }));
}
