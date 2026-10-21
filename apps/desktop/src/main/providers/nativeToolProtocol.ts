import { Buffer } from "node:buffer";
import type {
  ApprovalRequest,
  ExternalToolCall,
  ExternalToolDefinition,
  ExternalToolHandler,
  ExternalToolResult,
  ProviderAbortSignal,
  ProviderApprovalDecision,
} from "@contracts/provider";

const MAX_TOOLS = 32;
const MAX_NAME_LENGTH = 48;
const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_TOTAL_SCHEMA_BYTES = 128 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_NODES = 512;
const MAX_PROPERTIES = 100;
const SDK_TOOL_PREFIX = "mcode_renderer__";
const PI_SDK_TOOL_PREFIX = "app_external__";

const SCHEMA_KEYS = new Set([
  "$schema", "$id", "title", "description", "type", "properties", "required",
  "additionalProperties", "items", "enum", "const", "minLength", "maxLength",
  "minItems", "maxItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
]);
const JSON_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonText(value: unknown, label: string): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-serializable`);
  }
  if (encoded === undefined) throw new Error(`${label} must be JSON-serializable`);
  return encoded;
}

function jsonBytes(value: unknown, label: string): number {
  return Buffer.byteLength(jsonText(value, label), "utf8");
}

function validInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isJsonScalar(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

function matchesSchemaType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "object": return isPlainRecord(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return true;
  }
}

function validateSchemaNode(schema: unknown, path: string, depth: number, budget: { nodes: number }): string | null {
  if (!isPlainRecord(schema)) return `${path} must be a JSON Schema object`;
  if (depth > MAX_SCHEMA_DEPTH) return `${path} exceeds maximum schema depth`;
  budget.nodes++;
  if (budget.nodes > MAX_SCHEMA_NODES) return "inputSchema has too many schema nodes";

  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYS.has(key)) return `${path} uses unsupported JSON Schema keyword ${key}`;
  }
  if (schema.type !== undefined && (typeof schema.type !== "string" || !JSON_TYPES.has(schema.type))) {
    return `${path}.type is unsupported`;
  }
  if (schema.type === undefined && schema.enum === undefined && !Object.prototype.hasOwnProperty.call(schema, "const")) {
    return `${path}.type is required in the supported JSON Schema subset`;
  }
  if (schema.description !== undefined && (typeof schema.description !== "string" || schema.description.length > 4_000)) {
    return `${path}.description must be a string up to 4000 characters`;
  }
  if (schema.title !== undefined && (typeof schema.title !== "string" || schema.title.length > 200)) {
    return `${path}.title must be a string up to 200 characters`;
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (schema[key] !== undefined && !validInteger(schema[key])) return `${path}.${key} must be a non-negative integer`;
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) {
      return `${path}.${key} must be a finite number`;
    }
  }
  if (typeof schema.minLength === "number" && typeof schema.maxLength === "number" && schema.minLength > schema.maxLength) {
    return `${path}.minLength exceeds maxLength`;
  }
  if (typeof schema.minItems === "number" && typeof schema.maxItems === "number" && schema.minItems > schema.maxItems) {
    return `${path}.minItems exceeds maxItems`;
  }
  if (typeof schema.minimum === "number" && typeof schema.maximum === "number" && schema.minimum > schema.maximum) {
    return `${path}.minimum exceeds maximum`;
  }
  if ((schema.minLength !== undefined || schema.maxLength !== undefined) && schema.type !== "string") {
    return `${path}.minLength/maxLength require type=string`;
  }
  if ((schema.minItems !== undefined || schema.maxItems !== undefined) && schema.type !== "array") {
    return `${path}.minItems/maxItems require type=array`;
  }
  if ([schema.minimum, schema.maximum, schema.exclusiveMinimum, schema.exclusiveMaximum].some((value) => value !== undefined) && schema.type !== "number" && schema.type !== "integer") {
    return `${path} numeric bounds require type=number or integer`;
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    return `${path}.additionalProperties must be a boolean in the supported schema subset`;
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 100) {
      return `${path}.enum must contain 1–100 JSON scalar values`;
    }
    if (!schema.enum.every(isJsonScalar)) return `${path}.enum supports only string, number, boolean or null values`;
    if (schema.type !== undefined && !schema.enum.every((value) => matchesSchemaType(value, schema.type))) {
      return `${path}.enum contains a value incompatible with type=${String(schema.type)}`;
    }
    try { jsonText(schema.enum, `${path}.enum`); } catch (error) { return (error as Error).message; }
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    if (!isJsonScalar(schema.const)) return `${path}.const supports only string, number, boolean or null values`;
    if (schema.type !== undefined && !matchesSchemaType(schema.const, schema.type)) {
      return `${path}.const is incompatible with type=${String(schema.type)}`;
    }
    try { jsonText(schema.const, `${path}.const`); } catch (error) { return (error as Error).message; }
  }

  if (schema.type === "object") {
    const properties = schema.properties === undefined ? {} : schema.properties;
    if (!isPlainRecord(properties)) return `${path}.properties must be an object`;
    const keys = Object.keys(properties);
    if (keys.length > MAX_PROPERTIES) return `${path}.properties exceeds ${MAX_PROPERTIES} properties`;
    for (const key of keys) {
      if (UNSAFE_KEYS.has(key)) return `${path}.properties contains unsafe key ${key}`;
      const error = validateSchemaNode(properties[key], `${path}.properties.${key}`, depth + 1, budget);
      if (error) return error;
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string")) {
        return `${path}.required must be a string array`;
      }
      if (new Set(schema.required).size !== schema.required.length) return `${path}.required contains duplicates`;
      for (const key of schema.required as string[]) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) return `${path}.required references unknown property ${key}`;
      }
    }
    if (schema.items !== undefined) return `${path}.items is only valid for array schemas`;
  } else if (schema.type === "array") {
    if (schema.items === undefined) return `${path}.items is required for array schemas`;
    const error = validateSchemaNode(schema.items, `${path}.items`, depth + 1, budget);
    if (error) return error;
    if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
      return `${path} contains object-only keywords on an array schema`;
    }
  } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined || schema.items !== undefined) {
    return `${path} contains keywords incompatible with type ${String(schema.type)}`;
  }
  return null;
}

/** Validate and clone request-local tool definitions before they reach an SDK. */
export function validateExternalToolDefinitions(raw: unknown): ExternalToolDefinition[] {
  if (!Array.isArray(raw)) throw new Error("externalTools must be an array");
  if (raw.length > MAX_TOOLS) throw new Error(`externalTools exceeds the ${MAX_TOOLS}-tool limit`);
  let totalSchemaBytes = 0;
  const names = new Set<string>();
  const normalized: ExternalToolDefinition[] = [];

  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!isPlainRecord(item)) throw new Error(`externalTools[${index}] must be an object`);
    const { name, description, inputSchema } = item;
    if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(name)) {
      throw new Error(`externalTools[${index}].name is invalid (expected 1–48 ASCII letters, digits, _ or -)`);
    }
    if (name.startsWith("mcode_renderer__")) throw new Error(`external tool name ${name} uses a reserved provider namespace`);
    if (names.has(name)) throw new Error(`duplicate external tool name: ${name}`);
    names.add(name);
    if (typeof description !== "string" || description.trim().length === 0 || description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(`external tool ${name} description must be 1–${MAX_DESCRIPTION_LENGTH} characters`);
    }
    const schemaError = validateSchemaNode(inputSchema, `external tool ${name}.inputSchema`, 0, { nodes: 0 });
    if (schemaError) throw new Error(schemaError);
    if (!isPlainRecord(inputSchema) || inputSchema.type !== "object") {
      throw new Error(`external tool ${name}.inputSchema must have type=object`);
    }
    const schemaBytes = jsonBytes(inputSchema, `external tool ${name}.inputSchema`);
    if (schemaBytes > MAX_SCHEMA_BYTES) throw new Error(`external tool ${name}.inputSchema exceeds ${MAX_SCHEMA_BYTES} bytes`);
    totalSchemaBytes += schemaBytes;
    if (totalSchemaBytes > MAX_TOTAL_SCHEMA_BYTES) throw new Error(`external tool schemas exceed ${MAX_TOTAL_SCHEMA_BYTES} bytes total`);
    normalized.push({
      name,
      description: description.trim(),
      inputSchema: JSON.parse(jsonText(inputSchema, `external tool ${name}.inputSchema`)) as Record<string, unknown>,
    });
  }
  return normalized;
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => deepEqualJson(value, b[i]));
  }
  if (isPlainRecord(a) || isPlainRecord(b)) {
    if (!isPlainRecord(a) || !isPlainRecord(b)) return false;
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    return aKeys.length === bKeys.length && aKeys.every((key, i) => key === bKeys[i] && deepEqualJson(a[key], b[key]));
  }
  return false;
}

export function validateExternalToolInput(schema: Record<string, unknown>, input: unknown): string | null {
  try {
    if (jsonBytes(input, "external tool input") > MAX_INPUT_BYTES) return `input exceeds ${MAX_INPUT_BYTES} bytes`;
  } catch (error) {
    return (error as Error).message;
  }
  return validateValue(input, schema, "$input", 0);
}

function validateValue(value: unknown, schema: Record<string, unknown>, path: string, depth: number): string | null {
  if (depth > MAX_SCHEMA_DEPTH) return `${path} exceeds maximum validation depth`;
  if (Object.prototype.hasOwnProperty.call(schema, "const") && !deepEqualJson(value, schema.const)) return `${path} does not match const`;
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).some((item) => deepEqualJson(value, item))) return `${path} is not in enum`;

  switch (schema.type) {
    case "object": {
      if (!isPlainRecord(value)) return `${path} must be an object`;
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = (schema.required ?? []) as string[];
      for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) return `${path}.${key} is required`;
      }
      for (const [key, item] of Object.entries(value)) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) {
          const error = validateValue(item, properties[key]!, `${path}.${key}`, depth + 1);
          if (error) return error;
        } else if (schema.additionalProperties === false) {
          return `${path}.${key} is not allowed`;
        }
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} has fewer than minItems`;
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} exceeds maxItems`;
      const itemSchema = schema.items as Record<string, unknown>;
      for (let i = 0; i < value.length; i++) {
        const error = validateValue(value[i], itemSchema, `${path}[${i}]`, depth + 1);
        if (error) return error;
      }
      return null;
    }
    case "string": {
      if (typeof value !== "string") return `${path} must be a string`;
      const length = Array.from(value).length;
      if (typeof schema.minLength === "number" && length < schema.minLength) return `${path} is shorter than minLength`;
      if (typeof schema.maxLength === "number" && length > schema.maxLength) return `${path} exceeds maxLength`;
      return null;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) {
        return `${path} must be a finite ${String(schema.type)}`;
      }
      if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} is below minimum`;
      if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} exceeds maximum`;
      if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return `${path} must exceed exclusiveMinimum`;
      if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return `${path} must be below exclusiveMaximum`;
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be a boolean`;
    case "null":
      return value === null ? null : `${path} must be null`;
    default:
      return null;
  }
}

export const EXTERNAL_TOOL_SDK_PREFIX = SDK_TOOL_PREFIX;

export function externalToolSdkName(name: string): string {
  return `${SDK_TOOL_PREFIX}${name}`;
}

/** Pi's global tool_call guard treats app_* tools as self-approving; our host callback is the actual approval gate. */
export function piExternalToolSdkName(name: string): string {
  return `${PI_SDK_TOOL_PREFIX}${name}`;
}

export function originalExternalToolName(sdkName: string): string | null {
  if (!sdkName.startsWith(SDK_TOOL_PREFIX)) return null;
  const name = sdkName.slice(SDK_TOOL_PREFIX.length);
  return /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(name) ? name : null;
}

export function codexExternalToolDescriptors(tools: ExternalToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    name: externalToolSdkName(tool.name),
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export function externalToolResultText(result: ExternalToolResult): string {
  if (result.status === "success") {
    if (typeof result.result === "string") return result.result;
    try { return JSON.stringify(result.result); } catch { return "External tool returned a non-serializable result."; }
  }
  return result.error || (result.status === "cancelled" ? "External tool call was cancelled." : "External tool call failed.");
}

/** Codex app-server's native dynamicTools request/reply bridge. */
export async function dispatchCodexExternalToolCall(args: {
  sdkToolName: string;
  callId: unknown;
  input: unknown;
  sessionId: string;
  tools: ExternalToolDefinition[];
  invokeExternalTool?: (call: ExternalToolCall, signal?: ProviderAbortSignal) => Promise<ExternalToolResult>;
  signal: ProviderAbortSignal;
}): Promise<{ matched: false } | { matched: true; response: { success: boolean; contentItems: Array<{ type: "inputText"; text: string }> } }> {
  if (!args.sdkToolName.startsWith(SDK_TOOL_PREFIX)) return { matched: false };
  const fail = (message: string) => ({
    matched: true as const,
    response: { success: false, contentItems: [{ type: "inputText" as const, text: message }] },
  });
  const externalName = originalExternalToolName(args.sdkToolName);
  const definition = externalName ? args.tools.find((tool) => tool.name === externalName) : undefined;
  if (!externalName || !definition) return fail("unsupported: external tool is not allowed in this request");
  if (typeof args.callId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(args.callId)) {
    return fail("external tool call rejected: missing or invalid SDK call id");
  }
  if (!args.invokeExternalTool) return fail("unsupported: no host external-tool callback is connected");
  if (args.signal.aborted) return fail("external tool call cancelled");
  let result: ExternalToolResult;
  try {
    result = await args.invokeExternalTool({
      sessionId: args.sessionId,
      callId: args.callId,
      name: externalName,
      input: args.input,
    }, args.signal);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  result = validateExternalToolResultEnvelope(result, args.sessionId, args.callId);
  if (args.signal.aborted) return fail("external tool call cancelled");
  if (result.status === "cancelled") return fail(result.error || "external tool call cancelled");
  return {
    matched: true,
    response: {
      success: result.status === "success",
      contentItems: [{ type: "inputText", text: externalToolResultText(result) }],
    },
  };
}

export interface ExternalToolDispatcher {
  invoke(call: ExternalToolCall, callSignal?: ProviderAbortSignal): Promise<ExternalToolResult>;
  close(): void;
}

interface ExternalToolDispatcherOptions {
  sessionId: string;
  tools: ExternalToolDefinition[];
  handler?: ExternalToolHandler;
  requestApproval?: (request: ApprovalRequest) => Promise<ProviderApprovalDecision>;
  /** Session-scoped grants are read from the existing ApprovalBridge policy. */
  isToolAlwaysAllowed?: (sessionId: string, toolName: string) => boolean;
  /** Preserve Pi/Mcode's dontAsk semantics: unapproved side-effecting tools are denied, not prompted. */
  isDontAskMode?: (sessionId: string) => boolean;
  signal: ProviderAbortSignal;
}

function errorResult(sessionId: string, callId: string, error: string): ExternalToolResult {
  return { sessionId, callId, status: "error", error: error.slice(0, 4_000) };
}

function cancelledResult(sessionId: string, callId: string, error = "external tool call cancelled"): ExternalToolResult {
  return { sessionId, callId, status: "cancelled", error: error.slice(0, 4_000) };
}

function combineAbortSignals(signals: Array<ProviderAbortSignal | undefined>): { signal: ProviderAbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  const abort = () => { if (!controller.signal.aborted) controller.abort(); };
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", abort));
  }
  return { signal: controller.signal, dispose: () => { for (const cleanup of cleanups) cleanup(); } };
}

function raceAbort<T>(
  promise: Promise<T>,
  signals: Array<ProviderAbortSignal | undefined>,
): Promise<{ aborted: true } | { aborted: false; value: T }> {
  return new Promise((resolve) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    const finish = (result: { aborted: true } | { aborted: false; value: T }) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      resolve(result);
    };
    const onAbort = () => finish({ aborted: true });
    for (const signal of signals) {
      if (!signal) continue;
      if (signal.aborted) {
        finish({ aborted: true });
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onAbort));
    }
    promise.then(
      (value) => finish({ aborted: false, value }),
      () => finish({ aborted: false, value: undefined as T }),
    );
  });
}

function normalizeToolResult(value: unknown, expectedSessionId: string, expectedCallId: string): ExternalToolResult {
  if (!isPlainRecord(value) || typeof value.status !== "string") {
    return errorResult(expectedSessionId, expectedCallId, "external tool handler returned an invalid result");
  }
  if (value.sessionId !== expectedSessionId || value.callId !== expectedCallId) {
    return errorResult(expectedSessionId, expectedCallId, "external tool result session/call id mismatch");
  }
  if (value.status === "cancelled") {
    return cancelledResult(expectedSessionId, expectedCallId, typeof value.error === "string" ? value.error : "external tool call cancelled");
  }
  if (value.status === "error") {
    return typeof value.error === "string"
      ? errorResult(expectedSessionId, expectedCallId, value.error)
      : errorResult(expectedSessionId, expectedCallId, "external tool handler returned an error without a message");
  }
  if (value.status !== "success" || !Object.prototype.hasOwnProperty.call(value, "result")) {
    return errorResult(expectedSessionId, expectedCallId, "external tool handler returned an invalid success result");
  }
  try {
    if (jsonBytes(value.result, "external tool result") > MAX_RESULT_BYTES) {
      return errorResult(expectedSessionId, expectedCallId, `external tool result exceeds ${MAX_RESULT_BYTES} bytes`);
    }
    return {
      sessionId: expectedSessionId,
      callId: expectedCallId,
      status: "success",
      result: JSON.parse(jsonText(value.result, "external tool result")) as unknown,
    };
  } catch (error) {
    return errorResult(expectedSessionId, expectedCallId, (error as Error).message);
  }
}

/** Validate that an adapter received the response for the call it actually issued. */
export function validateExternalToolResultEnvelope(
  value: unknown,
  expectedSessionId: string,
  expectedCallId: string,
): ExternalToolResult {
  return normalizeToolResult(value, expectedSessionId, expectedCallId);
}

/** Request-local dispatcher: allowlist, schema, approval, call-id, session and cancellation gates. */
export function createExternalToolDispatcher(options: ExternalToolDispatcherOptions): ExternalToolDispatcher {
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  const seenCallIds = new Set<string>();
  const dispatcherAbort = new AbortController();
  let active = true;

  return {
    close() {
      active = false;
      dispatcherAbort.abort();
    },
    async invoke(call, callSignal) {
      const record: Record<string, unknown> = isPlainRecord(call) ? call : {};
      const responseSessionId = typeof record.sessionId === "string" ? record.sessionId : options.sessionId;
      const responseCallId = typeof record.callId === "string" && record.callId.length <= 128 ? record.callId : "invalid-call-id";
      const fail = (message: string) => errorResult(responseSessionId, responseCallId, message);
      const cancelled = (message: string) => cancelledResult(responseSessionId, responseCallId, message);
      if (!active || options.signal.aborted || callSignal?.aborted || dispatcherAbort.signal.aborted) return cancelled("provider turn is no longer active");
      if (!isPlainRecord(call) || call.sessionId !== options.sessionId) return fail("external tool call belongs to a different session");
      if (typeof call.callId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(call.callId)) return fail("external tool call has an invalid call id");
      if (seenCallIds.has(call.callId)) return fail("duplicate or expired external tool call id");
      seenCallIds.add(call.callId);
      if (typeof call.name !== "string") return fail("external tool call has no tool name");
      const definition = tools.get(call.name);
      if (!definition) return fail(`external tool is not allowed in this request: ${call.name}`);
      const inputError = validateExternalToolInput(definition.inputSchema, call.input);
      if (inputError) return fail(`invalid arguments for ${call.name}: ${inputError}`);
      if (!options.handler) return fail("unsupported: no host external-tool handler is connected");

      let approvedInput = call.input;
      let previouslyApproved = false;
      try { previouslyApproved = options.isToolAlwaysAllowed?.(options.sessionId, call.name) === true; }
      catch { return fail("external tool denied: could not verify the existing approval policy"); }
      if (!previouslyApproved && options.isDontAskMode?.(options.sessionId)) {
        return fail("external tool denied: dontAsk mode requires a prior explicit approval");
      }
      if (!previouslyApproved) {
        if (!options.requestApproval) return fail("external tool denied: no user approval channel is available");
        const approvalRequest: ApprovalRequest = {
          // ApprovalBridge keys pending requests globally, so include the session
          // as well as the SDK call id to prevent parallel sessions from colliding.
          requestId: `external-tool:${options.sessionId}:${call.callId}`,
          toolName: call.name,
          input: call.input,
          description: definition.description,
        };
        const approval = await raceAbort(options.requestApproval(approvalRequest), [options.signal, callSignal, dispatcherAbort.signal]);
        if (approval.aborted || !active || options.signal.aborted || callSignal?.aborted || dispatcherAbort.signal.aborted) return cancelled("external tool approval was cancelled");
        if (!approval.value) return fail("external tool approval failed");
        if (!approval.value.allow) return fail(approval.value.reason || "external tool call was denied by the user");
        approvedInput = approval.value.updatedInput === undefined ? call.input : approval.value.updatedInput;
      }
      const approvedInputError = validateExternalToolInput(definition.inputSchema, approvedInput);
      if (approvedInputError) return fail(`approved arguments for ${call.name} are invalid: ${approvedInputError}`);

      const invocation: ExternalToolCall = {
        sessionId: options.sessionId,
        callId: call.callId,
        name: call.name,
        input: approvedInput,
      };
      const combined = combineAbortSignals([options.signal, callSignal, dispatcherAbort.signal]);
      try {
        const pending = Promise.resolve().then(() => options.handler!(invocation, combined.signal));
        const handled = await raceAbort(pending, [options.signal, callSignal, dispatcherAbort.signal, combined.signal]);
        if (handled.aborted || !active || options.signal.aborted || callSignal?.aborted || dispatcherAbort.signal.aborted) {
          return cancelled("external tool result arrived after cancellation");
        }
        return normalizeToolResult(handled.value, options.sessionId, call.callId);
      } finally {
        combined.dispose();
      }
    },
  };
}
