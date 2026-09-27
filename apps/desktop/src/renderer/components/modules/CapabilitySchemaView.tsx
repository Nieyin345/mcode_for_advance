import type { JsonSchemaDocument, ModuleJsonValue } from "@contracts/moduleCapability";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** Upper bound for the raw JSON shown in the catalog. The host already caps a
 * schema at MODULE_SCHEMA_MAX_BYTES; this only keeps a single row readable. */
const RAW_PREVIEW_CHARS = 6000;

function isRecord(value: ModuleJsonValue | undefined): value is { [key: string]: ModuleJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One-line type text for a property schema. Only reads plain fields: a local
 * `$ref` is shown as its pointer text and never dereferenced/expanded. */
function typeText(schema: ModuleJsonValue | undefined, refLabel: (ref: string) => string): string {
  if (schema === true) return "any";
  if (!isRecord(schema)) return "—";
  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.filter((v): v is string => typeof v === "string").join(" | ") || "—";
  if (typeof schema.$ref === "string") return refLabel(schema.$ref);
  if (Array.isArray(schema.enum)) return "enum";
  for (const key of ["anyOf", "oneOf", "allOf"] as const) if (Array.isArray(schema[key])) return key;
  return "—";
}

/**
 * Discovery-only rendering of a capability's input/output JSON Schema.
 * Everything is rendered as React text (escaped); nothing is compiled,
 * evaluated, fetched or recursively expanded. Runtime validation stays in the
 * host's Zod schemas.
 */
export function CapabilitySchemaView({
  label,
  schema,
  testId,
}: {
  label: string;
  schema: JsonSchemaDocument;
  testId: string;
}) {
  const { t } = useI18n();
  const refLabel = (ref: string) => t("ide.modules.schemaRef", { ref });
  const properties = isRecord(schema.properties) ? Object.entries(schema.properties) : [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((v): v is string => typeof v === "string") : []);
  const raw = JSON.stringify(schema, null, 2);
  const truncated = raw.length > RAW_PREVIEW_CHARS;
  return (
    <div data-testid={testId} className="space-y-1">
      <div className="font-medium text-content">
        {label} <span className="font-normal text-content-subtle">· {typeText(schema, refLabel)}</span>
      </div>
      {properties.length > 0 ? (
        <ul className="space-y-0.5">
          {properties.map(([name, value]) => (
            <li key={name} data-testid="schema-field" className="flex flex-wrap items-baseline gap-1.5">
              <code className="break-all font-mono text-content">{name}</code>
              <span className="text-content-subtle">{typeText(value, refLabel)}</span>
              {required.has(name) && <span className="text-warning">{t("ide.modules.schemaRequired")}</span>}
              {isRecord(value) && typeof value.description === "string" && (
                <span className="break-words text-content-muted">— {value.description}</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-content-subtle">{t("ide.modules.schemaNoFields")}</p>
      )}
      <details>
        <summary className="cursor-pointer text-content-subtle">{t("ide.modules.schemaRaw")}</summary>
        <pre data-testid="schema-raw" className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-muted p-2 font-mono text-[0.9em]">
          {truncated ? raw.slice(0, RAW_PREVIEW_CHARS) : raw}
        </pre>
        {truncated && <p className="text-content-subtle">{t("ide.modules.schemaTruncated", { n: RAW_PREVIEW_CHARS })}</p>}
      </details>
    </div>
  );
}
