import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

const parameters = Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) });
const inside = (path: string, root: string) => { const value = relative(root, path); return value === '' || (!value.startsWith('..') && !isAbsolute(value)); };
export function sensitivePath(path: string, protectedRoots: string[]) {
  const parts = path.split('/');
  return protectedRoots.some(root => inside(path, root)) || parts.some(part => /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.gnupg|\.npmrc|\.netrc|\.pypirc|\.zshrc|\.zprofile|\.bashrc|\.bash_profile|\.kube)$/.test(part)) || inside(path, join(homedir(), 'Library/Keychains')) || inside(path, join(homedir(), '.config/gcloud'));
}
/** Text reader with a bounded buffer, bounded scan and no implicit CSV parsing. */
export function readTool(workspace: string, protectedRoots: string[]): ToolDefinition<typeof parameters> {
  return { name: 'read', label: '读取文件', description: 'Read a text file using an absolute path or a path relative to the workspace. offset is a 1-based line number. Output and scanning are bounded; sensitive files are denied.', parameters,
    async execute(_id, params, signal) {
      const requested = resolve(workspace, params.path);
      const actual = await realpath(requested);
      const roots = await Promise.all(protectedRoots.map(async root => { try { return await realpath(root); } catch { return resolve(root); } }));
      if (sensitivePath(requested, protectedRoots) || sensitivePath(actual, roots)) throw new Error('禁止读取凭证或工作台控制文件');
      const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await file.stat()).isFile()) throw new Error('只能读取普通文本文件');
        const decoder = new TextDecoder('utf-8'); const buffer = Buffer.alloc(16 * 1024);
        let scanned = 0, line = 1, output = '', outputBytes = 0, truncated = false;
        const offset = params.offset ?? 1, limit = params.limit ?? 200;
        outer: while (scanned < 8 * 1024 * 1024) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          scanned += bytesRead;
          const chunk = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
          for (const char of chunk) {
            if (line >= offset) { output += char; outputBytes += Buffer.byteLength(char); }
            if (char === '\n') line++;
            if (outputBytes >= 48 * 1024 || line >= offset + limit) { truncated = true; break outer; }
          }
        }
        if (scanned >= 8 * 1024 * 1024) truncated = true;
        if (line < offset && !output) throw new Error('未在扫描范围内找到该行；请减小 offset 或使用其他通用工具读取');
        return { content: [{ type: 'text', text: output + (truncated ? `\n[读取已截断；当前到第 ${line} 行。]` : '') }], details: { truncated, scannedBytes: scanned } };
      } finally { await file.close(); }
    },
  };
}
