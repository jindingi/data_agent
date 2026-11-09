import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../../src/main/storage/database';
import { CredentialService } from '../../../src/main/services/credentials';
import type { CompatibleModel } from '../../../src/shared/compatible-models';

it('models.compatible-store isolates credentials, models, cache revisions and recovery for both protocols', async () => {
  const root = mkdtempSync(join(tmpdir(), 'data-agent-compatible-store-'));
  const db = openDatabase(join(root, 'state.sqlite'));
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (v: Buffer) => v.toString(),
  };
  const a = 'openai-chat-compatible',
    b = 'openai-responses-compatible';
  const definition: CompatibleModel = {
    model: 'same-id',
    name: 'same',
    contextWindow: 1000000,
    maxTokens: 16384,
    reasoning: true,
    vision: false,
    profile: 'deepseek',
  };
  try {
    const store = new CredentialService(db, encryption);
    store.setCatalog([]);
    store.saveConnection(a, 'https://a.example/v1', 'key-a');
    store.saveConnection(b, 'https://b.example/v1', 'key-b');
    store.saveCompatible(a, [definition]);
    store.saveCompatible(b, [definition]);
    store.select({ provider: a, model: definition.model });
    store.setThinking('high');
    store.select({ provider: b, model: definition.model });
    store.setThinking('low');
    expect(store.thinking({ provider: a, model: definition.model })).toBe('high');
    expect(store.thinking()).toBe('low');
    const snapshot = store.compatibleModel({ provider: a, model: definition.model });
    store.saveCompatible(a, [{ ...definition, maxTokens: 8192 }]);
    expect(snapshot?.maxTokens).toBe(16384);
    expect(store.compatibleModel({ provider: b, model: definition.model })).toEqual(definition);
    const fetcher = async () =>
      new Response(JSON.stringify({ data: [{ id: 'unrecognized-model' }] }));
    await store.discover(a, undefined, fetcher);
    expect(store.settings().discoveredIds[a]).toEqual(['unrecognized-model']);
    expect(store.settings().models.map((m) => m.provider)).toEqual([a, b]);
    store.save(a, '');
    expect(store.key(b)).toBe('key-b');
    expect(store.settings().models.map((m) => m.provider)).toEqual([b]);
    expect(store.settings().compatibleModels[a]).toHaveLength(1);
    store.save(a, 'rotated');
    let finish!: (r: Response) => void;
    const pending = store.discover(
      a,
      undefined,
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    store.saveCompatible(a, [definition]);
    finish(await fetcher());
    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
    const restored = new CredentialService(db, encryption);
    restored.setCatalog([]);
    expect(restored.key(b)).toBe('key-b');
    expect(restored.endpoint(a)).toBe('https://a.example/v1');
    expect(restored.settings().compatibleModels[b]).toEqual([definition]);
    db.prepare('UPDATE app_metadata SET value=? WHERE key=?').run(
      '{"schemaVersion":99,"models":[]}',
      `compatibleConfig.${a}`,
    );
    expect(restored.settings().compatibleErrors[a]).toContain('版本');
    expect(() => restored.validate({ provider: a, model: definition.model })).toThrow();
    expect(restored.settings().models.map((m) => m.provider)).toEqual([b]);
    restored.saveCompatible(a, [definition]);
    expect(restored.settings().compatibleErrors).toEqual({});
    expect(() => restored.saveCompatible(a, [definition, definition])).toThrow();
    expect(restored.settings().compatibleModels[a]).toEqual([definition]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
