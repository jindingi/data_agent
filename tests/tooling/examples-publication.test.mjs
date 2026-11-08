import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  publicExampleRoot,
  publicExampleSnapshot,
  assertPublicExampleFile,
} from '../../scripts/examples/public-snapshot.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
function fixture(root) {
  const binding = {
    config: { systemPrompt: 'Synthetic analysis', enabledSkills: ['analysis'] },
    skills: [{ id: 'analysis', filePath: `${root}/skills/analysis/SKILL.md`, content: 'Frozen' }],
    revision: 2,
  };
  binding.fingerprint = hash(JSON.stringify({ config: binding.config, skills: binding.skills }));
  const entries = [
    { type: 'session', id: 'synthetic-session', cwd: `${root}/workspace/session` },
    {
      type: 'custom',
      customType: 'data_agent.agent_config',
      data: { fingerprint: binding.fingerprint, revision: 2 },
    },
    {
      type: 'message',
      id: 'request',
      message: { role: 'user', content: `Read ${root}/workspace/session/data.csv` },
    },
    {
      type: 'message',
      id: 'response',
      message: { role: 'assistant', content: 'Generated report.', usage: { totalTokens: 123 } },
    },
  ];
  return { binding, native: Buffer.from(entries.map((e) => JSON.stringify(e)).join('\n') + '\n') };
}

test('publication copies normalize machine paths consistently and preserve original evidence', () => {
  const root = '/tmp/example-author',
    a = fixture(root),
    before = structuredClone(a.binding);
  const published = publicExampleSnapshot(a.native, a.binding, root);
  assert.deepEqual(a.binding, before);
  assert(!published.native.includes(root));
  assert.equal(
    published.binding.skills[0].filePath,
    `${publicExampleRoot}/skills/analysis/SKILL.md`,
  );
  assert.equal(
    published.binding.fingerprint,
    hash(JSON.stringify({ config: published.binding.config, skills: published.binding.skills })),
  );
  assert.deepEqual(
    Buffer.from(
      published.native
        .toString()
        .replaceAll(publicExampleRoot, root)
        .replaceAll(published.binding.fingerprint, a.binding.fingerprint),
    ),
    a.native,
    'only publication paths and their binding fingerprint may differ',
  );
  const b = fixture('/tmp/another-author');
  assert.deepEqual(publicExampleSnapshot(b.native, b.binding, '/tmp/another-author'), published);
  assertPublicExampleFile('session.jsonl', published.native);
  assert.throws(() => publicExampleSnapshot(a.native, a.binding, '/'), /explicit authoring/);
});

test('publication rejects unrecognized paths and credentials instead of normalizing unrelated directories', () => {
  const root = ['', 'home', 'example-author'].join('/'),
    a = fixture(root);
  const unrelated = Buffer.from(
    a.native.toString().replace(`${root}/workspace`, `${root}-other/workspace`),
  );
  const published = publicExampleSnapshot(unrelated, a.binding, root);
  assert.throws(() => assertPublicExampleFile('session.jsonl', published.native), /Private path/);
  const privatePath = ['', 'Users', 'example-user', 'outside'].join('/');
  assert.throws(
    () => assertPublicExampleFile('report.md', Buffer.from(privatePath)),
    /Private path/,
  );
  assert.throws(
    () =>
      assertPublicExampleFile(
        'session.jsonl',
        Buffer.from('sk-synthetic-test-key-not-a-real-credential'),
      ),
    /credential/,
  );
});

test('publication normalizes scratch files and truncated temporary paths from tool output', () => {
  const root = '/tmp/example-author',
    a = fixture(root);
  const native = Buffer.from(
    a.native
      .toString()
      .replace('Generated report.', 'Generated /tmp/scratch.txt; /private/tmp/example-au…'),
  );
  const published = publicExampleSnapshot(native, a.binding, root);
  assertPublicExampleFile('session.jsonl', published.native);
  assert(published.native.includes(`${publicExampleRoot}/temporary/scratch.txt`));
  assert(published.native.includes(`${publicExampleRoot}/temporary/example-au…`));
});

test('shipped publication has matching hashes and bindings without author-machine paths', () => {
  const root = new URL('../../resources/examples/', import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL('catalog.json', root)));
  const provenance = JSON.parse(readFileSync(new URL('provenance.json', root)));
  assert.equal(provenance.publication.publicRoot, publicExampleRoot);
  for (const [path, expected] of Object.entries(catalog.files)) {
    const bytes = readFileSync(new URL(path, root));
    assertPublicExampleFile(path, bytes);
    assert.equal(bytes.length, expected.bytes, path);
    assert.equal(hash(bytes), expected.sha256, path);
  }
  for (const example of catalog.examples) {
    const binding = JSON.parse(
      readFileSync(new URL(`${example.directory}/agent-binding.json`, root)),
    );
    const native = readFileSync(new URL(`${example.directory}/session.jsonl`, root));
    const record = provenance.examples.find((e) => e.id === example.id);
    assert.equal(record.publishedSessionSha256, hash(native));
    assert.notEqual(record.originalSessionSha256, record.publishedSessionSha256);
    assert.equal(record.skillFingerprint, binding.fingerprint);
    assert.equal(
      binding.fingerprint,
      hash(JSON.stringify({ config: binding.config, skills: binding.skills })),
    );
    const entries = native
      .toString()
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert(entries[0].cwd.startsWith(`${publicExampleRoot}/`));
    assert(
      entries.some(
        (e) =>
          e.customType === 'data_agent.agent_config' && e.data.fingerprint === binding.fingerprint,
      ),
    );
    assert(
      entries.some((e) => e.message?.role === 'assistant' && e.message.usage?.totalTokens > 0),
    );
  }
});
