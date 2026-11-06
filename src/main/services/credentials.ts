import type Database from 'better-sqlite3';
import { AppError } from '../../shared/errors';
import { DEFAULT_MODEL, modelChoiceSchema, type ModelChoice, type ModelOption, type ModelSettings } from '../../shared/runtime';

interface Encryption { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
/** Only Main decrypts saved BYOK. Renderer receives presence metadata, never saved keys. */
export class CredentialService {
  private models: ModelOption[] = [];
  constructor(private db: Database.Database, private encryption: Encryption) {}
  setCatalog(models: ModelOption[]) { this.models = models; }
  private get(key: string) { return (this.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key) as { value: string } | undefined)?.value; }
  private set(key: string, value: string) { this.db.prepare('INSERT INTO app_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  selected(): ModelChoice {
    try { return modelChoiceSchema.parse(JSON.parse(this.get('model.selected') || 'null')); } catch { return DEFAULT_MODEL; }
  }
  settings(): ModelSettings {
    return { selected: this.selected(), models: this.models, configuredProviders: this.db.prepare("SELECT key FROM app_metadata WHERE key LIKE 'credential.%'").all().map(row => (row as { key: string }).key.slice('credential.'.length)), encryptionAvailable: this.encryption.isEncryptionAvailable() };
  }
  validate(model: ModelChoice) {
    if (!this.models.some(item => item.provider === model.provider && item.model === model.model)) throw new AppError('UNKNOWN_MODEL', '所选模型不在内置模型列表中');
  }
  select(model: ModelChoice) { this.validate(model); this.set('model.selected', JSON.stringify(model)); return this.settings(); }
  save(provider: string, key: string) {
    if (!this.models.some(model => model.provider === provider)) throw new AppError('UNKNOWN_PROVIDER', '不支持此模型提供方');
    if (!key.trim()) { this.db.prepare('DELETE FROM app_metadata WHERE key=?').run(`credential.${provider}`); return this.settings(); }
    if (!this.encryption.isEncryptionAvailable()) throw new AppError('KEYCHAIN_UNAVAILABLE', '系统安全存储不可用，无法保存 API key');
    this.set(`credential.${provider}`, this.encryption.encryptString(key.trim()).toString('base64'));
    return this.settings();
  }
  key(provider: string): string {
    const encoded = this.get(`credential.${provider}`);
    if (!encoded) throw new AppError('MISSING_KEY', '请在设置中配置所选模型提供方的 API key');
    if (!this.encryption.isEncryptionAvailable()) throw new AppError('KEYCHAIN_UNAVAILABLE', '系统安全存储不可用');
    try { return this.encryption.decryptString(Buffer.from(encoded, 'base64')); } catch { throw new AppError('KEYCHAIN_ERROR', '无法解密 API key，请重新配置'); }
  }
}
