import assert from 'node:assert/strict';
import { portableSse } from './portable-sse.mjs';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    );
  return value;
}
/** Exact request matching; only scenario-declared runtime paths are portable. No prompt scrubbing. */
export function codec(bindings) {
  function replace(text, decode) {
    for (const [key, value] of Object.entries(bindings).sort((a, b) => b[1].length - a[1].length)) {
      if (!value || !/^[A-Z_]+$/.test(key)) throw new Error('Invalid cassette binding');
      text = text.replaceAll(decode ? `{{${key}}}` : value, decode ? value : `{{${key}}}`);
    }
    return text;
  }
  function walk(value, decode) {
    if (typeof value === 'string') return replace(value, decode);
    if (Array.isArray(value)) return value.map((item) => walk(item, decode));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, walk(item, decode)]),
      );
    return value;
  }
  return { encode: (value) => walk(sorted(value), false), decode: (value) => walk(value, true) };
}

/** Captures response bytes as UTF-8 SSE chunks; never records request/response headers or keys. */
export async function modelCassette({
  mode,
  file,
  bindings = {},
  key,
  upstream = 'https://api.deepseek.com/chat/completions',
  maxRequests = 4,
  fetchImpl = fetch,
  provenance = 'deepseek-live',
}) {
  if (!['record', 'replay'].includes(mode)) throw new Error('Unknown cassette mode');
  if (mode === 'record' && (!key || process.env.DATA_AGENT_TEST_MODEL_MODE !== 'live'))
    throw new Error('Recording requires explicit live mode and credentials');
  if (mode === 'record' && upstream !== 'https://api.deepseek.com/chat/completions')
    throw new Error('Only the official DeepSeek endpoint is allowed');
  const versions = JSON.parse(readFileSync('package.json', 'utf8')).dependencies;
  const sdk = Object.fromEntries(
    Object.entries(versions).filter(([name]) => name.startsWith('@earendil-works/')),
  );
  const cassette =
    mode === 'record'
      ? { version: 1, provenance, recordedAt: new Date().toISOString(), sdk, exchanges: [] }
      : JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(cassette.version, 1, 'Unsupported cassette schema');
  assert.deepEqual(cassette.sdk, sdk, 'SDK changed: review and re-record the fixture');
  assert(cassette.exchanges.length > 0 || mode === 'record', 'Empty recording');
  const transform = codec(bindings),
    errors = [],
    controllers = new Set();
  let cursor = 0;
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const bodyChunks = [];
      let bodyBytes = 0;
      for await (const chunk of request) {
        bodyBytes += chunk.length;
        if (bodyBytes > 2_000_000) throw new Error('Request too large');
        bodyChunks.push(chunk);
      }
      const body = Buffer.concat(bodyChunks).toString('utf8');
      const payload = JSON.parse(body),
        normalized = transform.encode(payload),
        index = cursor++;
      if (index >= maxRequests) throw new Error('Cassette request budget exceeded');
      if (mode === 'replay') {
        const exchange = cassette.exchanges[index];
        if (!exchange)
          throw new Error(`Unexpected extra request ${index + 1}; replay never falls back to live`);
        if (digest(normalized) !== exchange.requestHash)
          throw new Error(
            `Cassette request ${index + 1} mismatch (prompt/tools/history/model changed); review and re-record`,
          );
        assert.equal(digest(exchange.request), exchange.requestHash, 'Corrupt request checksum');
        assert.equal(digest(exchange.chunks), exchange.responseHash, 'Corrupt response checksum');
        response.writeHead(exchange.status, { 'Content-Type': exchange.contentType });
        for (const chunk of exchange.chunks) {
          if (response.destroyed) break;
          response.write(transform.decode(chunk));
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        response.end();
      } else {
        // The application receives only a synthetic BYOK key; the recorder alone holds the live key.
        const result = await fetchImpl(upstream, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body,
          signal: controller.signal,
        });
        const contentType = result.headers.get('content-type') ?? 'application/json';
        response.writeHead(result.status, { 'Content-Type': contentType });
        const chunks = [],
          decoder = new TextDecoder();
        let bytes = 0;
        for await (const chunk of result.body) {
          bytes += chunk.length;
          if (bytes > 2_000_000) throw new Error('Response too large');
          const text = decoder.decode(chunk, { stream: true });
          chunks.push(text);
          response.write(text);
        }
        const tail = decoder.decode();
        if (tail) {
          chunks.push(tail);
          response.write(tail);
        }
        response.end();
        // Normalize after joining so paths split between network chunks cannot escape replacement.
        const frames = contentType.includes('text/event-stream')
          ? portableSse(chunks.join(''), bindings)
          : [transform.encode(chunks.join(''))];
        const exchange = {
          request: normalized,
          requestHash: digest(normalized),
          status: result.status,
          contentType,
          chunks: frames,
          responseHash: digest(frames),
        };
        const serialized = JSON.stringify(exchange);
        if (serialized.includes(key))
          throw new Error('Credential detected in recording; refused to save');
        cassette.exchanges.push(exchange);
      }
    } catch (error) {
      // Never serialize fetch exceptions or headers: their causes may include credentials.
      const message =
        mode === 'replay'
          ? String(error.message)
          : 'Live recording failed (request/response, timeout, budget or credential check)';
      errors.push(message);
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message } }));
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    bind: (name, value) => {
      bindings[name] = value;
    },
    assertComplete() {
      assert.deepEqual(errors, [], 'Cassette transport errors');
      assert.equal(cursor, cassette.exchanges.length, 'Missing, extra or incomplete exchanges');
      assert(cursor > 0, 'Scenario did not use the model');
    },
    save() {
      assert.equal(mode, 'record');
      this.assertComplete();
      writeFileSync(file, JSON.stringify(cassette, null, 2) + '\n');
    },
    get exchanges() {
      return cassette.exchanges;
    },
    async close() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
