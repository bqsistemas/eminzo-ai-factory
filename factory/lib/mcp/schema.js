// The small subset of JSON Schema the MCP tools declare for their arguments, and a validator for it.
// Supported: an object with `properties`, `required` and `additionalProperties: false`; each property a
// string (optionally `enum`, `pattern`, `format: "date-time"`), an integer (`minimum`, `maximum`) or a boolean.
// Anything else in a schema is a programming error and throws when the tool is defined.

const PROPERTY_KEYS = new Set(['type', 'description', 'enum', 'pattern', 'format', 'minimum', 'maximum']);
const TYPES = new Set(['string', 'integer', 'boolean']);

/** Throws when `schema` uses something the validator does not understand. Returns the schema. */
export function checkSchema(schema) {
  if (schema?.type !== 'object' || schema.additionalProperties !== false) throw new Error('tool schema: must be an object with additionalProperties false');
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (!TYPES.has(prop.type)) throw new Error(`tool schema: ${key}: unsupported type ${JSON.stringify(prop.type)}`);
    const extra = Object.keys(prop).filter((k) => !PROPERTY_KEYS.has(k));
    if (extra.length) throw new Error(`tool schema: ${key}: unsupported keyword ${extra[0]}`);
    if (prop.format !== undefined && prop.format !== 'date-time') throw new Error(`tool schema: ${key}: unsupported format ${prop.format}`);
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(schema.properties ?? {}, key)) throw new Error(`tool schema: required ${key} is not a property`);
  }
  return schema;
}

/** A date-time argument: an ISO 8601 date or date and time that Date.parse reads. */
export const isDateTime = (value) => /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value) && Number.isFinite(Date.parse(value));

function problemOf(key, prop, value) {
  switch (prop.type) {
    case 'string':
      if (typeof value !== 'string') return `${key} must be a string`;
      if (prop.enum && !prop.enum.includes(value)) return `${key} must be one of ${prop.enum.join(', ')}`;
      if (prop.pattern && !new RegExp(prop.pattern, 'u').test(value)) return `${key} does not match ${prop.pattern}`;
      if (prop.format === 'date-time' && !isDateTime(value)) return `${key} must be an ISO 8601 date or date-time`;
      return null;
    case 'integer':
      if (!Number.isInteger(value)) return `${key} must be an integer`;
      if (prop.minimum !== undefined && value < prop.minimum) return `${key} must be >= ${prop.minimum}`;
      if (prop.maximum !== undefined && value > prop.maximum) return `${key} must be <= ${prop.maximum}`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${key} must be true or false`;
    default:
      return `${key} has an unsupported type`;
  }
}

/** Every problem with `args` against `schema`, in a stable order; [] when the arguments are valid. */
export function validateArgs(schema, args) {
  const properties = schema.properties ?? {};
  const problems = [];
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(args, key)) problems.push(`${key} is required`);
  }
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(properties, key)) {
      problems.push(`unknown argument ${key}`);
      continue;
    }
    const problem = problemOf(key, properties[key], value);
    if (problem) problems.push(problem);
  }
  return problems;
}
