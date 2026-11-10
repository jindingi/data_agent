import {
  compatibleConfigSchema,
  compatibleModelOption,
  type CompatibleModel,
} from '../../shared/compatible-models';
import { isCompatibleProvider } from '../../shared/providers';
import { PROVIDERS, providerDefinition } from '../../shared/providers';
import { discoverModelIds } from './model-discovery';
import type Database from 'better-sqlite3';
import { normalizeEndpoint, recommendedThinking } from '../../shared/model-configuration';
import { AppError } from '../../shared/errors';
import {
  DEFAULT_MODEL,
  modelChoiceSchema,
  type ModelChoice,
  type ModelOption,
  type ModelSettings,
  type ThinkingLevel,
} from '../../shared/runtime';

interface Encryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
/** Only Main decrypts saved BYOK. Renderer receives presence metadata, never saved keys. */
export class CredentialService {
  private models: ModelOption[] = [];
  private discoveryTickets = new Map<string, number>();
  constructor(
    private db: Database.Database,
    private encryption: Encryption,
  ) {}
  setCatalog(models: ModelOption[]) {
    this.models = models.filter((m) => PROVIDERS.some((p) => p.id === m.provider));
    // Retire unsupported connection metadata without touching session history or artifacts.
    this.db.transaction(() => {
      for (const row of this.db.prepare('SELECT key FROM app_metadata').all() as {
        key: string;
      }[]) {
        const match = /^(credential|endpoint|catalog|connectionRevision)\.(.+)$/.exec(row.key);
        const thinking = /^thinking\.([^/]+)\//.exec(row.key);
        const provider = match?.[2] ?? thinking?.[1];
        if (provider && !PROVIDERS.some((p) => p.id === provider))
          this.db.prepare('DELETE FROM app_metadata WHERE key=?').run(row.key);
      }
      const selected = this.selected();
      this.set('model.selected', JSON.stringify(selected));
    })();
  }
  private get(key: string) {
    return (
      this.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key) as
        { value: string } | undefined
    )?.value;
  }
  private set(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO app_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  selected(): ModelChoice {
    try {
      const model = modelChoiceSchema.parse(JSON.parse(this.get('model.selected') || 'null'));
      providerDefinition(model.provider);
      return model;
    } catch {
      return DEFAULT_MODEL;
    }
  }
  settings(): ModelSettings {
    const compatibleModels: Record<string, CompatibleModel[]> = {};
    const compatibleErrors: Record<string, string> = {};
    for (const { id } of PROVIDERS.filter((p) => isCompatibleProvider(p.id))) {
      try {
        compatibleModels[id] = this.compatibleDefinitions(id);
      } catch {
        compatibleErrors[id] = '兼容模型配置损坏或版本不受支持，请重新保存模型配置';
      }
    }
    return {
      compatibleModels,
      compatibleErrors,
      discoveredIds: Object.fromEntries(
        PROVIDERS.map(({ id }) => [id, this.catalog(id)?.ids ?? []]),
      ),
      thinkingLevel: this.thinking(),
      endpoints: Object.fromEntries(PROVIDERS.map(({ id }) => [id, this.endpoint(id) ?? ''])),
      selected: this.selected(),
      models: this.availableModels(),
      catalogs: Object.fromEntries(
        PROVIDERS.flatMap(({ id }) => {
          const cache = this.catalog(id);
          return cache
            ? [
                [
                  id,
                  {
                    fetchedAt: cache.fetchedAt,
                    count: isCompatibleProvider(id)
                      ? cache.ids.length
                      : this.availableModels().filter((m) => m.provider === id).length,
                  },
                ],
              ]
            : [];
        }),
      ),
      configuredProviders: this.db
        .prepare("SELECT key FROM app_metadata WHERE key LIKE 'credential.%'")
        .all()
        .map((row) => (row as { key: string }).key.slice('credential.'.length)),
      encryptionAvailable: this.encryption.isEncryptionAvailable(),
    };
  }
  compatibleDefinitions(provider: string): CompatibleModel[] {
    if (!isCompatibleProvider(provider)) return [];
    const raw = this.get(`compatibleConfig.${provider}`);
    if (!raw) return [];
    try {
      return compatibleConfigSchema.parse(JSON.parse(raw)).models;
    } catch {
      throw new AppError(
        'INVALID_MODEL_CONFIG',
        '兼容模型配置损坏或版本不受支持，请重新保存模型配置',
      );
    }
  }
  compatibleModel(model: ModelChoice) {
    return this.compatibleDefinitions(model.provider).find((item) => item.model === model.model);
  }
  saveCompatible(provider: string, models: CompatibleModel[]) {
    if (!isCompatibleProvider(provider))
      throw new AppError('UNKNOWN_PROVIDER', '仅兼容提供方支持自定义模型');
    const config = compatibleConfigSchema.parse({ schemaVersion: 1, models });
    this.db.transaction(() => {
      this.set(`compatibleConfig.${provider}`, JSON.stringify(config));
      this.set(
        `connectionRevision.${provider}`,
        String(Number(this.get(`connectionRevision.${provider}`) ?? 0) + 1),
      );
    })();
    return this.settings();
  }
  private configuredModels(): ModelOption[] {
    return PROVIDERS.flatMap(({ id }) => {
      if (!isCompatibleProvider(id)) return this.models.filter((m) => m.provider === id);
      try {
        return this.compatibleDefinitions(id).map((m) => compatibleModelOption(id, m));
      } catch {
        return [];
      }
    });
  }
  validate(model: ModelChoice) {
    if (
      !this.configuredModels().some(
        (item) => item.provider === model.provider && item.model === model.model,
      )
    )
      throw new AppError('UNKNOWN_MODEL', '请先配置所选模型的能力');
    if (!this.get(`credential.${model.provider}`))
      throw new AppError('MISSING_KEY', '请在设置中配置所选模型提供方的 API key');
    if (
      !this.availableModels().some((m) => m.provider === model.provider && m.model === model.model)
    )
      throw new AppError('MODEL_LIST_REQUIRED', '请先获取模型列表并选择可用模型');
  }
  thinking(model = this.selected()): ThinkingLevel {
    const levels = this.configuredModels().find(
      (item) => item.provider === model.provider && item.model === model.model,
    )?.thinkingLevels ?? ['off'];
    const saved = this.get(`thinking.${model.provider}/${model.model}`) as
      ThinkingLevel | undefined;
    return saved && levels.includes(saved)
      ? saved
      : recommendedThinking(
          this.configuredModels().find(
            (item) => item.provider === model.provider && item.model === model.model,
          ),
        );
  }
  setThinking(level: ThinkingLevel) {
    const model = this.selected();
    this.validate(model);
    if (
      !this.configuredModels()
        .find((item) => item.provider === model.provider && item.model === model.model)!
        .thinkingLevels.includes(level)
    )
      throw new AppError('UNSUPPORTED_THINKING', '所选模型不支持该思考级别');
    this.set(`thinking.${model.provider}/${model.model}`, level);
    return this.settings();
  }
  select(model: ModelChoice) {
    this.validate(model);
    this.set('model.selected', JSON.stringify(model));
    return this.settings();
  }
  save(provider: string, key: string) {
    providerDefinition(provider);
    if (!key.trim()) {
      this.invalidateCatalog(provider);
      this.db.prepare('DELETE FROM app_metadata WHERE key=?').run(`credential.${provider}`);
      return this.settings();
    }
    if (!this.encryption.isEncryptionAvailable())
      throw new AppError('KEYCHAIN_UNAVAILABLE', '系统安全存储不可用，无法保存 API key');
    const encrypted = this.encryption.encryptString(key.trim()).toString('base64');
    this.db.transaction(() => {
      this.invalidateCatalog(provider);
      this.set(`credential.${provider}`, encrypted);
    })();
    return this.settings();
  }
  endpoint(provider: string): string | undefined {
    return this.get(`endpoint.${provider}`) || undefined;
  }
  saveConnection(provider: string, baseUrl: string, key?: string) {
    providerDefinition(provider);
    const endpoint = baseUrl.trim() ? normalizeEndpoint(baseUrl) : '';
    if (endpoint !== (this.endpoint(provider) ?? '') && !key?.trim())
      throw new AppError('ENDPOINT_KEY_REQUIRED', '修改地址时请重新输入此地址使用的 API key');
    this.db.transaction(() => {
      if (key !== undefined) this.save(provider, key);
      if (endpoint !== (this.endpoint(provider) ?? '')) this.invalidateCatalog(provider);
      this.set(`endpoint.${provider}`, endpoint);
    })();
    return this.settings();
  }
  private invalidateCatalog(provider: string) {
    this.db.prepare('DELETE FROM app_metadata WHERE key=?').run(`catalog.${provider}`);
    this.set(
      `connectionRevision.${provider}`,
      String(Number(this.get(`connectionRevision.${provider}`) ?? 0) + 1),
    );
  }
  private catalog(provider: string): { ids: string[]; fetchedAt: string } | undefined {
    try {
      const value = JSON.parse(this.get(`catalog.${provider}`) ?? 'null');
      if (
        value &&
        Array.isArray(value.ids) &&
        value.ids.every((id: unknown) => typeof id === 'string') &&
        typeof value.fetchedAt === 'string'
      )
        return value;
    } catch {
      /* Corrupt cache is refetched explicitly, never replaced by a static list. */
    }
  }
  private availableModels() {
    const ids = new Map(PROVIDERS.map((p) => [p.id as string, new Set(this.catalog(p.id)?.ids)]));
    return this.configuredModels().filter((m) =>
      isCompatibleProvider(m.provider)
        ? !!this.get(`credential.${m.provider}`)
        : ids.get(m.provider)?.has(m.model),
    );
  }
  async discover(provider: string, testBaseUrl?: string, fetcher?: typeof fetch) {
    const definition = providerDefinition(provider);
    const ticket = (this.discoveryTickets.get(provider) ?? 0) + 1;
    this.discoveryTickets.set(provider, ticket);
    const revision = this.get(`connectionRevision.${provider}`);
    const ids = await discoverModelIds(
      testBaseUrl ?? this.endpoint(provider) ?? definition.baseUrl,
      this.key(provider),
      fetcher,
    );
    if (
      revision !== this.get(`connectionRevision.${provider}`) ||
      ticket !== this.discoveryTickets.get(provider)
    )
      throw new AppError('CONNECTION_CHANGED', '连接配置已变更，请重新获取模型列表');
    this.set(`catalog.${provider}`, JSON.stringify({ ids, fetchedAt: new Date().toISOString() }));
    return this.settings();
  }
  key(provider: string): string {
    providerDefinition(provider);
    const encoded = this.get(`credential.${provider}`);
    if (!encoded) throw new AppError('MISSING_KEY', '请在设置中配置所选模型提供方的 API key');
    if (!this.encryption.isEncryptionAvailable())
      throw new AppError('KEYCHAIN_UNAVAILABLE', '系统安全存储不可用');
    try {
      return this.encryption.decryptString(Buffer.from(encoded, 'base64'));
    } catch {
      throw new AppError('KEYCHAIN_ERROR', '无法解密 API key，请重新配置');
    }
  }
}
