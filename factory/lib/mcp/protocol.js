// A Model Context Protocol server over newline-delimited JSON-RPC 2.0, written by hand so the engine keeps no
// runtime dependencies. It offers tools and nothing else, and never sends requests of its own.
//
// Dual-era, as the MCP versioning rules describe it:
//   - a request whose params._meta carries "io.modelcontextprotocol/protocolVersion" is served statelessly
//     under that revision (2026-07-28): every result carries resultType "complete", and an unknown version
//     gets UnsupportedProtocolVersionError (-32022) listing the supported ones;
//   - an `initialize` request selects a handshake revision (2025-11-25 and earlier) for the rest of the process;
//   - a request with neither is served with the handshake-era result shapes, which every client reads.
import { createInterface } from 'node:readline';

export const MODERN_VERSIONS = Object.freeze(['2026-07-28']);
export const LEGACY_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
export const SUPPORTED_VERSIONS = Object.freeze([...MODERN_VERSIONS, ...LEGACY_VERSIONS]);

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

export const ERROR_CODES = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unsupportedVersion: -32022,
});

/** Longest accepted line, in characters: a client never needs more to call a read-only tool. */
export const MAX_LINE = 1024 * 1024;

/** A failure the model should read and act on: returned as a tool result with isError, never as a protocol error. */
export class ToolError extends Error {}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));

const failure = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });
const success = (id, result) => ({ jsonrpc: '2.0', id, result });

/** The text a tool result carries: its message, or its data as JSON for clients that ignore structuredContent. */
const textBlock = (text) => [{ type: 'text', text }];

/**
 * A transport-free MCP server. `handle` takes one parsed JSON-RPC message and resolves the response to
 * write, or null when there is nothing to answer (a notification, or a response sent by the client).
 *
 * Each tool is `{ name, title, description, inputSchema, annotations, validate(args) -> string[], run(args) }`;
 * `run` returns a plain object (the structured result) or throws ToolError.
 * @param {{ name: string, version: string, instructions?: string, tools: object[], log?: (text: string) => void }} options
 */
export function createMcpServer({ name, version, instructions, tools, log = () => {} }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const listed = tools.map(({ name: n, title, description, inputSchema, annotations }) => ({
    name: n,
    ...(title ? { title } : {}),
    description,
    inputSchema,
    ...(annotations ? { annotations } : {}),
  }));
  /** The handshake revision chosen by `initialize`, or null before (or without) one. */
  let negotiated = null;

  function initialize(id, params) {
    const requested = isObject(params) ? params.protocolVersion : undefined;
    negotiated = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
    return success(id, {
      protocolVersion: negotiated,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name, version },
      ...(instructions ? { instructions } : {}),
    });
  }

  function discover(id) {
    return success(id, {
      resultType: 'complete',
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      _meta: { [META_SERVER_INFO]: { name, version } },
      ...(instructions ? { instructions } : {}),
    });
  }

  async function callTool(params) {
    if (!isObject(params) || typeof params.name !== 'string') return { error: 'tools/call needs params.name' };
    const tool = byName.get(params.name);
    if (!tool) return { error: `unknown tool: ${params.name}` };
    const args = params.arguments ?? {};
    if (!isObject(args)) return { result: { content: textBlock('arguments must be a JSON object'), isError: true } };
    const problems = tool.validate(args);
    if (problems.length) return { result: { content: textBlock(`invalid arguments: ${problems.join('; ')}`), isError: true } };
    try {
      const data = await tool.run(args);
      return { result: { content: textBlock(JSON.stringify(data)), structuredContent: data, isError: false } };
    } catch (err) {
      if (!(err instanceof ToolError)) log(`tool ${tool.name} failed: ${err?.stack ?? err}`);
      const message = err instanceof ToolError ? err.message : `internal error: ${err?.message ?? err}`;
      return { result: { content: textBlock(message), isError: true } };
    }
  }

  async function request(id, method, params) {
    if (method === 'initialize') return initialize(id, params);

    const meta = isObject(params) && isObject(params._meta) ? params._meta : null;
    const requested = meta && Object.hasOwn(meta, META_VERSION) ? meta[META_VERSION] : undefined;
    if (requested !== undefined && !MODERN_VERSIONS.includes(requested)) {
      return failure(id, ERROR_CODES.unsupportedVersion, 'Unsupported protocol version', { supported: [...SUPPORTED_VERSIONS], requested });
    }
    const modern = requested !== undefined;
    const done = (result) => success(id, modern ? { resultType: 'complete', ...result } : result);

    switch (method) {
      case 'server/discover':
        return discover(id);
      case 'ping':
        return done({});
      case 'tools/list':
        return done({ tools: listed });
      case 'tools/call': {
        const outcome = await callTool(params);
        return outcome.error ? failure(id, ERROR_CODES.invalidParams, outcome.error) : done(outcome.result);
      }
      default:
        return failure(id, ERROR_CODES.methodNotFound, `method not found: ${method}`);
    }
  }

  return {
    /** The handshake revision in use, or null. */
    get negotiated() { return negotiated; },

    /** @returns {Promise<object | null>} */
    async handle(message) {
      if (Array.isArray(message)) return failure(null, ERROR_CODES.invalidRequest, 'batches are not supported');
      if (!isObject(message) || message.jsonrpc !== '2.0') {
        return failure(isObject(message) && validId(message.id) ? message.id : null, ERROR_CODES.invalidRequest, 'not a JSON-RPC 2.0 message');
      }
      if (!Object.hasOwn(message, 'method')) return null; // a response: this server sends no requests, so none is expected
      if (typeof message.method !== 'string') return failure(validId(message.id) ? message.id : null, ERROR_CODES.invalidRequest, 'method must be a string');
      if (!Object.hasOwn(message, 'id')) return null; // a notification (initialized, cancelled, ...): nothing to answer
      if (!validId(message.id)) return failure(null, ERROR_CODES.invalidRequest, 'id must be a string or a number');
      if (message.params !== undefined && !isObject(message.params)) return failure(message.id, ERROR_CODES.invalidParams, 'params must be an object');
      try {
        return await request(message.id, message.method, message.params);
      } catch (err) {
        log(`request ${message.method} failed: ${err?.stack ?? err}`);
        return failure(message.id, ERROR_CODES.internal, 'internal error');
      }
    },
  };
}

/**
 * Serves `server` over newline-delimited JSON-RPC: one message per line in, one response per line out.
 * Messages are answered in arrival order. Resolves when the input closes (the client's way to stop the server).
 * @param {{ handle(message: unknown): Promise<object | null> }} server
 */
export function serveStdio(server, { input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  let queue = Promise.resolve();
  const send = (response) => {
    if (response) output.write(`${JSON.stringify(response)}\n`);
  };
  lines.on('line', (line) => {
    queue = queue.then(async () => {
      if (!line.trim()) return;
      if (line.length > MAX_LINE) return send(failure(null, ERROR_CODES.invalidRequest, `message longer than ${MAX_LINE} characters`));
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return send(failure(null, ERROR_CODES.parse, 'parse error: not valid JSON'));
      }
      send(await server.handle(message));
    });
  });
  return new Promise((resolve) => {
    lines.on('close', () => { queue.then(resolve); });
  });
}
