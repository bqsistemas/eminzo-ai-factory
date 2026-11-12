// The JSON Schema subset the MCP tools declare: refused keywords at definition time, problems at call time.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkSchema, isDateTime, validateArgs } from '../factory/lib/mcp/schema.js';

const SCHEMA = checkSchema({
  type: 'object',
  additionalProperties: false,
  required: ['job'],
  properties: {
    job: { type: 'string', pattern: '^#?\\d+$' },
    risk: { type: 'string', enum: ['low', 'high'] },
    since: { type: 'string', format: 'date-time' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    full: { type: 'boolean' },
  },
});

test('checkSchema refuses what the validator would silently ignore', () => {
  assert.throws(() => checkSchema({ type: 'object', properties: {} }), /additionalProperties false/);
  assert.throws(() => checkSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'array' } } }), /unsupported type/);
  assert.throws(() => checkSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'string', minLength: 1 } } }), /unsupported keyword minLength/);
  assert.throws(() => checkSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'string', format: 'email' } } }), /unsupported format/);
  assert.throws(() => checkSchema({ type: 'object', additionalProperties: false, required: ['b'], properties: {} }), /required b/);
});

test('validateArgs: valid arguments have no problems', () => {
  assert.deepEqual(validateArgs(SCHEMA, { job: '#161', risk: 'high', since: '2026-11-01', limit: 5, full: false }), []);
  assert.deepEqual(validateArgs(SCHEMA, { job: '161', since: '2026-11-01T10:00:00Z' }), []);
});

test('validateArgs names every problem in a stable order', () => {
  assert.deepEqual(validateArgs(SCHEMA, {}), ['job is required']);
  assert.deepEqual(validateArgs(SCHEMA, { job: 'x', risk: 'mid', since: 'yesterday', limit: 0, full: 'yes', other: 1 }), [
    'job does not match ^#?\\d+$',
    'risk must be one of low, high',
    'since must be an ISO 8601 date or date-time',
    'limit must be >= 1',
    'full must be true or false',
    'unknown argument other',
  ]);
  assert.deepEqual(validateArgs(SCHEMA, { job: '1', limit: 2.5 }), ['limit must be an integer']);
  assert.deepEqual(validateArgs(SCHEMA, { job: '1', limit: 101 }), ['limit must be <= 100']);
});

test('isDateTime accepts ISO dates and date-times only', () => {
  for (const ok of ['2026-11-12', '2026-11-12T15:00:00Z', '2026-11-12T15:00:00.123-05:00', '2026-11-12 15:00']) assert.ok(isDateTime(ok), ok);
  for (const bad of ['', 'today', '12/11/2026', '2026-13-45', '1731420000000']) assert.ok(!isDateTime(bad), bad);
});
