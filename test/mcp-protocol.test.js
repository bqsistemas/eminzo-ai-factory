// The hand-written MCP server: JSON-RPC 2.0 framing, both protocol eras (per-request _meta and the initialize
// handshake), tools/list, tools/call with argument validation and tool errors, and the stdio transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { ERROR_CODES, LEGACY_VERSIONS, MODERN_VERSIONS, SUPPORTED_VERSIONS, ToolError, createMcpServer, serveStdio } from '../factory/lib/mcp/protocol.js';
import { validateArgs } from '../factory/lib/mcp/schema.js';

const ECHO_SCHEMA = { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } };

function server(extra = {}) {
  const logs = [];
  const tools = [
    { name: 'echo', title: 'Echo', description: 'Says it back.', inputSchema: ECHO_SCHEMA, annotations: { readOnlyHint: true },
      validate: (args) => validateArgs(ECHO_SCHEMA, args), run: (args) => ({ said: args.text }) },
    { name: 'refuse', description: 'Always refuses.', inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      validate: () => [], run: () => { throw new ToolError('no job on this machine matches 999'); } },
    { name: 'crash', description: 'A bug.', inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      validate: () => [], run: () => { throw new TypeError('x is undefined'); } },
  ];
  const s = createMcpServer({ name: 'eminzo', version: '9.9.9', instructions: 'Read-only.', tools, log: (t) => logs.push(t), ...extra });
  return { s, logs };
}

const modern = (params = {}) => ({ ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSIONS[0] } });
const req = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

test('initialize negotiates a handshake revision: the requested one when supported, else the newest legacy one', async () => {
  const { s } = server();
  const res = await s.handle(req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } }));
  assert.deepEqual(res, {
    jsonrpc: '2.0', id: 1,
    result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'eminzo', version: '9.9.9' }, instructions: 'Read-only.' },
  });
  assert.equal(s.negotiated, '2025-06-18');
  const other = await server().s.handle(req(2, 'initialize', { protocolVersion: '1999-01-01' }));
  assert.equal(other.result.protocolVersion, LEGACY_VERSIONS[0]);
});

test('server/discover lists every supported version, the tools capability and the server identity', async () => {
  const { s } = server();
  const res = await s.handle(req('d', 'server/discover', modern()));
  assert.equal(res.result.resultType, 'complete');
  assert.deepEqual(res.result.supportedVersions, [...SUPPORTED_VERSIONS]);
  assert.deepEqual(res.result.capabilities, { tools: {} });
  assert.deepEqual(res.result._meta['io.modelcontextprotocol/serverInfo'], { name: 'eminzo', version: '9.9.9' });
});

test('a modern request with an unknown version gets UnsupportedProtocolVersionError with the supported list', async () => {
  const { s } = server();
  const res = await s.handle(req(3, 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } }));
  assert.equal(res.error.code, ERROR_CODES.unsupportedVersion);
  assert.equal(res.error.code, -32022);
  assert.deepEqual(res.error.data, { supported: [...SUPPORTED_VERSIONS], requested: '1900-01-01' });
});

test('tools/list: modern results carry resultType, legacy results do not; both list name, schema and annotations', async () => {
  const { s } = server();
  const now = await s.handle(req(4, 'tools/list', modern()));
  assert.equal(now.result.resultType, 'complete');
  const old = await s.handle(req(5, 'tools/list'));
  assert.equal(Object.hasOwn(old.result, 'resultType'), false);
  assert.deepEqual(old.result.tools.map((t) => t.name), ['echo', 'refuse', 'crash']);
  assert.deepEqual(old.result.tools[0], { name: 'echo', title: 'Echo', description: 'Says it back.', inputSchema: ECHO_SCHEMA, annotations: { readOnlyHint: true } });
  assert.equal(Object.hasOwn(old.result.tools[0], 'validate'), false, 'no function leaks into the listing');
});

test('tools/call returns the data as structuredContent and as JSON text', async () => {
  const { s } = server();
  const res = await s.handle(req(6, 'tools/call', modern({ name: 'echo', arguments: { text: 'hola' } })));
  assert.deepEqual(res.result, { resultType: 'complete', content: [{ type: 'text', text: '{"said":"hola"}' }], structuredContent: { said: 'hola' }, isError: false });
});

test('tools/call: bad arguments and tool errors are results with isError; an unknown tool is a protocol error', async () => {
  const { s, logs } = server();
  const bad = await s.handle(req(7, 'tools/call', { name: 'echo', arguments: { text: 3, extra: true } }));
  assert.equal(bad.result.isError, true);
  assert.equal(bad.result.content[0].text, 'invalid arguments: text must be a string; unknown argument extra');
  const missing = await s.handle(req(8, 'tools/call', { name: 'echo' }));
  assert.equal(missing.result.content[0].text, 'invalid arguments: text is required');
  const notObject = await s.handle(req(9, 'tools/call', { name: 'echo', arguments: ['x'] }));
  assert.equal(notObject.result.isError, true);
  const refused = await s.handle(req(10, 'tools/call', { name: 'refuse' }));
  assert.deepEqual(refused.result, { content: [{ type: 'text', text: 'no job on this machine matches 999' }], isError: true });
  const crashed = await s.handle(req(11, 'tools/call', { name: 'crash' }));
  assert.equal(crashed.result.isError, true);
  assert.equal(crashed.result.content[0].text, 'internal error: x is undefined');
  assert.match(logs.join('\n'), /tool crash failed: TypeError/);
  const unknown = await s.handle(req(12, 'tools/call', { name: 'nope' }));
  assert.equal(unknown.error.code, ERROR_CODES.invalidParams);
  assert.match(unknown.error.message, /unknown tool: nope/);
});

test('JSON-RPC edges: notifications and responses get no answer; bad messages and unknown methods get errors', async () => {
  const { s } = server();
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await s.handle({ jsonrpc: '2.0', id: 1, result: {} }), null);
  assert.equal((await s.handle([req(1, 'ping')])).error.code, ERROR_CODES.invalidRequest);
  assert.equal((await s.handle({ id: 1, method: 'ping' })).error.code, ERROR_CODES.invalidRequest);
  assert.equal((await s.handle({ jsonrpc: '2.0', id: null, method: 'ping' })).error.code, ERROR_CODES.invalidRequest);
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 1, method: 7 })).error.code, ERROR_CODES.invalidRequest);
  assert.equal((await s.handle(req(1, 'ping', ['x']))).error.code, ERROR_CODES.invalidParams);
  assert.equal((await s.handle(req(2, 'resources/list'))).error.code, ERROR_CODES.methodNotFound);
  assert.deepEqual(await s.handle(req(3, 'ping')), { jsonrpc: '2.0', id: 3, result: {} });
  assert.deepEqual(await s.handle(req(4, 'ping', modern())), { jsonrpc: '2.0', id: 4, result: { resultType: 'complete' } });
});

test('serveStdio: one response line per request, in order; bad JSON is a parse error; ends when input closes', async () => {
  const { s } = server();
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => { written += chunk; });
  const done = serveStdio(s, { input, output });
  input.write(`${JSON.stringify(req(1, 'initialize', { protocolVersion: '2025-11-25' }))}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  input.write('\n{ not json\n');
  input.write(`${JSON.stringify(req(2, 'tools/call', { name: 'echo', arguments: { text: 'a\nb' } }))}\n`);
  input.end();
  await done;
  const lines = written.trimEnd().split('\n');
  assert.equal(lines.length, 3, 'the notification and the blank line get nothing');
  const [init, parse, call] = lines.map((l) => JSON.parse(l));
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.deepEqual(parse, { jsonrpc: '2.0', id: null, error: { code: ERROR_CODES.parse, message: 'parse error: not valid JSON' } });
  assert.equal(call.result.structuredContent.said, 'a\nb');
  assert.ok(!lines.some((l) => l.includes('\n')), 'no message spans two lines');
});
