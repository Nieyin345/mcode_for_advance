import { z } from "zod";
import { LocalizedTextSchema, ModuleInvokeSchema, ModuleManifestSchema } from "./modules.js";

/** Discovery only: this bounded subset is NOT a runtime JSON Schema engine.
 * Runtime input/output Zod checks and host authorization remain authoritative. */
export const MODULE_SCHEMA_MAX_BYTES = 32 * 1024;
export const MODULE_SCHEMA_MAX_DEPTH = 12;
export const MODULE_SCHEMA_MAX_NODES = 2048;
export const MODULE_SCHEMA_MAX_ENTRIES = 128;
export const MODULE_CAPABILITY_RUNNER_KIND = "module-capability" as const;
export const MODULE_CAPABILITY_NODE_TYPE_ID = "mcode.module-capability" as const;

export type ModuleJsonValue = null | boolean | number | string | ModuleJsonValue[] | { [key: string]: ModuleJsonValue };
export type JsonSchemaDocument = { [keyword: string]: ModuleJsonValue };
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
const own = (object: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(object, key);

/** Clone only plain JSON data. Inspect property descriptors instead of reading
 * accessors; don't stringify an object with user-defined toJSON behavior. */
function copySchemaData(input: unknown): ModuleJsonValue {
  let nodes = 0, chars = 0;
  const ancestors = new Set<object>();
  const charge = (length: number): void => {
    chars += length;
    if (chars > MODULE_SCHEMA_MAX_BYTES) throw new Error("JSON schema character budget exceeded");
  };
  const visit = (value: unknown, depth: number): ModuleJsonValue => {
    if (depth > MODULE_SCHEMA_MAX_DEPTH) throw new Error("JSON schema depth limit exceeded");
    if (++nodes > MODULE_SCHEMA_MAX_NODES) throw new Error("JSON schema node budget exceeded");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") { charge(value.length); return value; }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object") throw new Error("JSON schema contains a non-JSON value");
    if (ancestors.has(value)) throw new Error("JSON schema contains a cycle");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error("JSON schema requires plain objects and arrays");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string")) throw new Error("JSON schema contains symbol keys");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    ancestors.add(value);
    try {
      if (array) {
        if (value.length > MODULE_SCHEMA_MAX_ENTRIES || keys.length !== value.length + 1) throw new Error("JSON schema array limit or sparse/extra entries");
        const result: ModuleJsonValue[] = [];
        for (let i = 0; i < value.length; i++) {
          const descriptor = descriptors[String(i)];
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("JSON schema arrays require data entries");
          result.push(visit(descriptor.value, depth + 1));
        }
        return result;
      }
      if (keys.length > MODULE_SCHEMA_MAX_ENTRIES) throw new Error("JSON schema object entry limit exceeded");
      const result: JsonSchemaDocument = Object.create(null) as JsonSchemaDocument;
      for (const key of keys as string[]) {
        if (forbiddenKeys.has(key)) throw new Error("JSON schema contains an unsafe property name");
        charge(key.length);
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("JSON schema requires enumerable data properties");
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally { ancestors.delete(value); }
  };
  const result = visit(input, 0);
  // Count encoded bytes, not UTF-16 code units; no Node-only Buffer in contracts.
  let bytes = 0;
  for (const char of JSON.stringify(result)) {
    const point = char.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > MODULE_SCHEMA_MAX_BYTES) throw new Error("JSON schema UTF-8 byte limit exceeded");
  }
  return result;
}

const schemaTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const stringKeywords = new Set(["title", "description", "format", "pattern"]);
const numberKeywords = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]);
const integerKeywords = new Set(["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]);
const booleanKeywords = new Set(["uniqueItems", "readOnly", "writeOnly", "deprecated"]);
const mapKeywords = new Set(["properties", "patternProperties", "definitions", "$defs"]);
const childKeywords = new Set(["additionalProperties", "additionalItems", "propertyNames", "contains", "not", "if", "then", "else"]);
const listKeywords = new Set(["allOf", "anyOf", "oneOf"]);
const objectValue = (value: ModuleJsonValue): value is JsonSchemaDocument => value !== null && typeof value === "object" && !Array.isArray(value);

function validateSchemaDocument(input: unknown): JsonSchemaDocument {
  const document = copySchemaData(input);
  if (!objectValue(document)) throw new Error("JSON schema document must be an object");
  const schemaNodes = new Set<string>();
  const references: string[] = [];
  const fail = (keyword: string): never => { throw new Error("Unsupported JSON schema keyword or value: " + keyword); };
  const walk = (value: ModuleJsonValue, path: string[] = []): void => {
    if (typeof value === "boolean") { schemaNodes.add(JSON.stringify(path)); return; }
    if (!objectValue(value)) return fail("schema");
    schemaNodes.add(JSON.stringify(path));
    for (const [key, item] of Object.entries(value)) {
      if (key === "$schema") {
        if (item !== "http://json-schema.org/draft-07/schema#" && item !== "https://json-schema.org/draft-07/schema#") fail(key);
      } else if (key === "$ref") {
        // Only JSON Pointers into this exact document; no remote loading,
        // URI-escaped fragments, named anchors, $id or dynamic references.
        if (typeof item !== "string" || item.length > 512 || !/^#(?:\/(?:[^~%#]|~[01])*)*$/.test(item)) fail(key);
        references.push(item as string);
      } else if (key === "type") {
        const values = Array.isArray(item) ? item : [item];
        if (!values.length || values.some(type => typeof type !== "string" || !schemaTypes.has(type)) || new Set(values).size !== values.length) fail(key);
      } else if (stringKeywords.has(key)) {
        if (typeof item !== "string") fail(key);
      } else if (numberKeywords.has(key)) {
        if (typeof item !== "number") fail(key);
      } else if (integerKeywords.has(key)) {
        if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) fail(key);
      } else if (key === "multipleOf") {
        if (typeof item !== "number" || item <= 0) fail(key);
      } else if (booleanKeywords.has(key)) {
        if (typeof item !== "boolean") fail(key);
      } else if (key === "required") {
        if (!Array.isArray(item) || item.some(name => typeof name !== "string" || forbiddenKeys.has(name)) || new Set(item).size !== item.length) fail(key);
      } else if (mapKeywords.has(key)) {
        if (!objectValue(item)) fail(key);
        for (const [name, child] of Object.entries(item as JsonSchemaDocument)) walk(child, [...path, key, name]);
      } else if (childKeywords.has(key)) {
        walk(item, [...path, key]);
      } else if (key === "items") {
        if (Array.isArray(item)) item.forEach((child, index) => walk(child, [...path, key, String(index)])); else walk(item, [...path, key]);
      } else if (listKeywords.has(key)) {
        if (!Array.isArray(item) || item.length === 0) fail(key);
        (item as ModuleJsonValue[]).forEach((child, index) => walk(child, [...path, key, String(index)]));
      } else if (key === "enum" || key === "examples") {
        if (!Array.isArray(item) || (key === "enum" && item.length === 0)) fail(key);
      } else if (key !== "default" && key !== "const") {
        fail(key);
      }
    }
  };
  walk(document);
  for (const reference of references) {
    let value: ModuleJsonValue = document;
    const tokens = (reference === "#" ? [] : reference.slice(2).split("/")).map(token => token.replace(/~1/g, "/").replace(/~0/g, "~"));
    for (const key of tokens) {
      if (value === null || typeof value !== "object" || !own(value, key)) throw new Error("Unresolved local JSON schema reference");
      value = (value as JsonSchemaDocument)[key]!;
    }
    if (!schemaNodes.has(JSON.stringify(tokens))) throw new Error("JSON schema reference must address a schema node");
  }
  return document;
}

export const JsonSchemaDocumentSchema = z.unknown().transform<JsonSchemaDocument>((input, context) => {
  try { return validateSchemaDocument(input); }
  catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "Invalid JSON schema document" });
    return z.NEVER;
  }
});

const Id = ModuleInvokeSchema.shape.moduleId;
const ContributionId = ModuleInvokeSchema.shape.contributionId;
const DescriptionSchema = z.object({ zh: z.string().min(1).max(2000), en: z.string().min(1).max(2000) }).strict();
export const ModuleCapabilityMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).max(40),
  title: LocalizedTextSchema,
  description: DescriptionSchema,
  permissions: z.array(z.literal("resource.read")).max(1),
  inputSchema: JsonSchemaDocumentSchema,
  outputSchema: JsonSchemaDocumentSchema,
  supportsCancellation: z.boolean(),
  limits: z.object({
    maxFileBytes: z.number().int().nonnegative().safe().optional(),
    taskTimeoutMs: z.number().int().positive().safe().optional(),
  }).strict().optional(),
}).strict();
export type ModuleCapabilityMetadata = z.infer<typeof ModuleCapabilityMetadataSchema>;

export const ModuleCapabilityDescriptorSchema = z.object({
  id: Id,
  kind: z.enum(["query", "action", "task"]),
  // No defaults: missing metadata means unknown, not a permission grant.
  metadata: ModuleCapabilityMetadataSchema.optional(),
}).strict();
export type ModuleCapabilityDescriptor = z.infer<typeof ModuleCapabilityDescriptorSchema>;

export const ModuleWorkflowTargetSchema = z.object({ moduleId: Id, contributionId: ContributionId, capabilityId: Id }).strict();
export type ModuleWorkflowTarget = z.infer<typeof ModuleWorkflowTargetSchema>;

/** Catalog validation checks referential consistency, NOT origin/authentication.
 * Only the host can know whether a core-prefixed module was really registered
 * as builtin. This schema must never be used instead of that host check. */
export const ModuleCatalogSchema = z.object({
  modules: z.array(ModuleManifestSchema).max(32),
  capabilities: z.array(ModuleCapabilityDescriptorSchema).max(128),
  workflowTargets: z.array(ModuleWorkflowTargetSchema).max(384).optional(),
}).strict().superRefine((catalog, context) => {
  const issue = (message: string): void => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (new Set(catalog.modules.map(module => module.id)).size !== catalog.modules.length) issue("Duplicate module ID");
  if (new Set(catalog.capabilities.map(capability => capability.id)).size !== catalog.capabilities.length) issue("Duplicate capability ID");
  const seen = new Set<string>();
  for (const target of catalog.workflowTargets ?? []) {
    const key = JSON.stringify([target.moduleId, target.contributionId]);
    if (seen.has(key)) issue("Duplicate workflow target");
    seen.add(key);
    const module = catalog.modules.find(item => item.id === target.moduleId);
    const contribution = module?.contributions.find(item => item.id === target.contributionId);
    const capability = catalog.capabilities.find(item => item.id === target.capabilityId);
    if (!module?.id.startsWith("core.") || contribution?.capability !== target.capabilityId || !capability || capability.kind === "action") {
      issue("Workflow target must reference a listed core contribution and read-only capability");
    }
  }
});

/** Stored/resolved workflow parameters. Passing this validation is NOT
 * authorization; user.* is syntactically valid but workflow execution is
 * still denied by the host. Expressions in path are data for the host resolver. */
export const ModuleWorkflowCallSchema = z.object({
  moduleId: Id,
  contributionId: ContributionId,
  path: z.string().min(1).max(4096).refine(value => value.trim().length > 0 && !value.includes("\0"), "Invalid workflow file path"),
}).strict();
export type ModuleWorkflowCall = z.infer<typeof ModuleWorkflowCallSchema>;

/** HOST-created input only. requestId identifies one dispatch attempt; never
 * accept it from WorkflowNode.params or regenerate it during task polling. */
export const ModuleWorkflowExecutionInputSchema = ModuleWorkflowCallSchema.extend({
  requestId: ModuleInvokeSchema.shape.requestId.refine(value => value.trim().length > 0 && !value.includes("\0"), "Invalid workflow request identity"),
}).strict();
export type ModuleWorkflowExecutionInput = z.infer<typeof ModuleWorkflowExecutionInputSchema>;
export const ModuleCapabilityRunnerSchema = z.object({ kind: z.literal(MODULE_CAPABILITY_RUNNER_KIND) }).strict();
