// The small subset of JSON Schema the MCP tools declare for their arguments, and a validator for it.
// Supported: objects with `properties`, `required` and `additionalProperties: false`; strings (`enum`,
// `pattern`, `maxLength`, `format: "date-time"`), integers (`minimum`, `maximum`), booleans, and arrays
// (`items`, `minItems`, `maxItems`) of any of these. Anything else in a schema is a programming error and throws
// when the tool is defined, so nothing is ever silently not checked.

const KEYWORDS = {
  object: new Set(['type', 'description', 'properties', 'required', 'additionalProperties']),
  string: new Set(['type', 'description', 'enum', 'pattern', 'format', 'maxLength']),
  integer: new Set(['type', 'description', 'minimum', 'maximum']),
  boolean: new Set(['type', 'description']),
  array: new Set(['type', 'description', 'items', 'minItems', 'maxItems']),
};

function checkNode(node, path) {
  const keywords = KEYWORDS[node?.type];
  if (!keywords) throw new Error(`tool schema: ${path}: unsupported type ${JSON.stringify(node?.type)}`);
  const extra = Object.keys(node).filter((k) => !keywords.has(k));
  if (extra.length) throw new Error(`tool schema: ${path}: unsupported keyword ${extra[0]}`);
  if (node.type === 'string' && node.format !== undefined && node.format !== 'date-time') throw new Error(`tool schema: ${path}: unsupported format ${node.format}`);
  if (node.type === 'array') {
    if (!node.items) throw new Error(`tool schema: ${path}: an array needs items`);
    checkNode(node.items, `${path}[]`);
  }
  if (node.type === 'object') {
    if (node.additionalProperties !== false) throw new Error(`tool schema: ${path}: an object must have additionalProperties false`);
    for (const [key, prop] of Object.entries(node.properties ?? {})) checkNode(prop, path ? `${path}.${key}` : key);
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(node.properties ?? {}, key)) throw new Error(`tool schema: required ${key} is not a property`);
    }
  }
}

/** Throws when `schema` uses something the validator does not understand. Returns the schema. */
export function checkSchema(schema) {
  if (schema?.type !== 'object' || schema.additionalProperties !== false) throw new Error('tool schema: must be an object with additionalProperties false');
  checkNode(schema, '');
  return schema;
}

/** A date-time argument: an ISO 8601 date or date and time that Date.parse reads. */
export const isDateTime = (value) => /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value) && Number.isFinite(Date.parse(value));

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function problemsOf(node, value, path, out) {
  switch (node.type) {
    case 'string':
      if (typeof value !== 'string') return out.push(`${path} must be a string`);
      if (node.enum && !node.enum.includes(value)) return out.push(`${path} must be one of ${node.enum.join(', ')}`);
      if (node.maxLength !== undefined && value.length > node.maxLength) return out.push(`${path} must be at most ${node.maxLength} characters`);
      if (node.pattern && !new RegExp(node.pattern, 'u').test(value)) return out.push(`${path} does not match ${node.pattern}`);
      if (node.format === 'date-time' && !isDateTime(value)) return out.push(`${path} must be an ISO 8601 date or date-time`);
      return undefined;
    case 'integer':
      if (!Number.isInteger(value)) return out.push(`${path} must be an integer`);
      if (node.minimum !== undefined && value < node.minimum) return out.push(`${path} must be >= ${node.minimum}`);
      if (node.maximum !== undefined && value > node.maximum) return out.push(`${path} must be <= ${node.maximum}`);
      return undefined;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : out.push(`${path} must be true or false`);
    case 'array':
      if (!Array.isArray(value)) return out.push(`${path} must be a list`);
      if (node.minItems !== undefined && value.length < node.minItems) return out.push(`${path} must have at least ${node.minItems} item${node.minItems === 1 ? '' : 's'}`);
      if (node.maxItems !== undefined && value.length > node.maxItems) return out.push(`${path} must have at most ${node.maxItems} items`);
      value.forEach((item, i) => problemsOf(node.items, item, `${path}[${i}]`, out));
      return undefined;
    case 'object': {
      if (!isObject(value)) return out.push(`${path} must be an object`);
      const properties = node.properties ?? {};
      const at = (key) => (path ? `${path}.${key}` : key);
      for (const key of node.required ?? []) if (!Object.hasOwn(value, key)) out.push(`${at(key)} is required`);
      for (const [key, v] of Object.entries(value)) {
        if (!Object.hasOwn(properties, key)) out.push(`unknown argument ${at(key)}`);
        else problemsOf(properties[key], v, at(key), out);
      }
      return undefined;
    }
    default:
      return out.push(`${path} has an unsupported type`);
  }
}

/** Every problem with `args` against `schema`, in a stable order; [] when the arguments are valid. */
export function validateArgs(schema, args) {
  const out = [];
  problemsOf(schema, args, '', out);
  return out;
}
