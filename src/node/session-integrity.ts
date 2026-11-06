import { existsSync, readFileSync, statSync } from 'node:fs';
import type { SessionState } from '../shared/models';

export interface SessionIntegrity { state: SessionState; piSessionId: string | null; error: string | null }
/** Read-only: never let SessionManager silently replace empty/damaged history. */
export function inspectSessionFile(file: string, expectedId: string | null, hadHistory: boolean): SessionIntegrity {
  const bad = (state: SessionState, error: string): SessionIntegrity => ({ state, piSessionId: expectedId, error });
  if (!existsSync(file)) return hadHistory ? bad('missing', '会话历史文件缺失，原会话未被重建。') : { state: 'draft', piSessionId: null, error: null };
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size === 0) return bad('corrupt', '会话文件为空或不是普通文件，已保留原件。');
    if (stat.size > 100 * 1024 * 1024) return bad('unavailable', '会话历史过大，无法完整检查。');
    const text = readFileSync(file, 'utf8');
    if (!text.endsWith('\n')) return bad('corrupt', '会话尾部不完整，已保留原件，请先恢复备份。');
    const lines = text.trimEnd().split('\n');
    const header = JSON.parse(lines.shift()!);
    if (header.type !== 'session' || typeof header.id !== 'string' || !header.id || typeof header.cwd !== 'string' || typeof header.timestamp !== 'string') return bad('corrupt', '会话文件头无效。');
    if (expectedId && header.id !== expectedId) return bad('corrupt', '会话身份与已登记历史不一致。');
    if (header.version !== 3) return bad('incompatible', '此会话格式需要迁移，已保留原件并停止自动打开。');
    const ids = new Set<string>();
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (!entry || typeof entry.id !== 'string' || ids.has(entry.id) || typeof entry.type !== 'string' || typeof entry.timestamp !== 'string') return bad('corrupt', '会话条目格式无效或 ID 重复。');
      if (entry.parentId !== null && (typeof entry.parentId !== 'string' || !ids.has(entry.parentId))) return bad('corrupt', '会话树包含无法关联的父节点。');
      if (entry.type === 'message' && (!entry.message || typeof entry.message.role !== 'string')) return bad('corrupt', '会话消息格式无效。');
      ids.add(entry.id);
    }
    return { state: 'persisted', piSessionId: header.id, error: null };
  } catch { return bad('corrupt', '会话文件无法完整读取或解析，已保留原件。'); }
}
