import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { resolve, join, extname, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalPath, inside, sensitivePath } from '../../node/path-policy';
import type { RuntimePaths } from '../../node/runtime-paths';
import type { ToolOperation } from '../../shared/tools';

const inspectSchema = z.object({ accesses: z.array(z.object({ action: z.enum(['read', 'write', 'delete']), path: z.string() })), scripts: z.array(z.object({ path: z.string(), cwd: z.string() })), sources: z.array(z.object({ source: z.string(), cwd: z.string() })), commands: z.array(z.object({ source: z.string(), cwd: z.string() })), network: z.array(z.string()), dynamic: z.array(z.string()), deny: z.array(z.string()) });
export interface PolicyContext { workspace: string; workingDirectory?: string; protectedRoots: string[]; inputs: string[]; published: string[] }
export interface PolicyDecision { decision: 'allow' | 'ask' | 'deny'; reasons: string[]; paths: { action: string; path: string }[]; scripts: { path: string; hash: string }[]; network: string[]; fingerprint: string }
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class PolicyService {
  constructor(private runtime: RuntimePaths) {}
  async inspect(context: PolicyContext, operation: ToolOperation): Promise<PolicyDecision> {
    const result: PolicyDecision = { decision: 'allow', reasons: [], paths: [], scripts: [], network: [], fingerprint: '' };
    const workspace = await canonicalPath(context.workspace, context.workspace);
    const cwd = await canonicalPath(context.workingDirectory ?? workspace, workspace);
    const roots = await Promise.all(context.protectedRoots.map(path => canonicalPath(path, workspace)));
    const runtimeRoot = await canonicalPath(this.runtime.root, workspace);
    const helpers = await canonicalPath(dirname(this.runtime.helpers), workspace);
    const inputs = await Promise.all(context.inputs.map(path => canonicalPath(path, workspace)));
    const published = await Promise.all(context.published.map(path => canonicalPath(path, workspace)));
    const mark = (decision: 'ask' | 'deny', reason: string) => { if (result.decision !== 'deny') result.decision = decision; if (!result.reasons.includes(reason)) result.reasons.push(reason); };
    const path = async (action: 'read' | 'write' | 'delete', raw: string) => {
      if (/[$`*?]/.test(raw)) mark('ask', '动态路径需要确认');
      const actual = await canonicalPath(raw, cwd); result.paths.push({ action, path: actual });
      if (sensitivePath(resolve(cwd, raw), context.protectedRoots) || sensitivePath(actual, roots) || action !== 'read' && roots.some(root => inside(root, actual))) mark('deny', '凭证或工作台控制文件禁止访问');
      else if (action !== 'read') {
        if (inside(actual, runtimeRoot) || inside(actual, helpers) || inside(runtimeRoot, actual) || inside(helpers, actual)) mark('deny', '禁止修改内置运行时或可信辅助脚本');
        else if (published.some(file => file === actual || action === 'delete' && inside(file, actual))) mark('deny', '已发布产物不可覆盖，请生成新版本');
        else if (inputs.some(file => file === actual || action === 'delete' && inside(file, actual))) mark('ask', '操作会修改用户选择的原文件');
        else if (!inside(actual, workspace)) mark('ask', '操作会写入或删除工作区外的文件');
      }
      return actual;
    };
    let inspected = 0;
    const analyze = async (source: string, mode: 'shell' | 'python', depth = 0, executionCwd = cwd, sourceFile?: string): Promise<void> => {
      if (depth > 4 || ++inspected > 16) { mark('deny', '代码检查超出复杂度限制'); return; }
      // execFile has no stdin option: pass bounded source via a private pipe below.
      const found = await this.analyze(source, mode, executionCwd, sourceFile);
      if (found.deny.length) mark('deny', `命令规则拒绝：${found.deny.join(', ')}`);
      if (found.dynamic.length) mark('ask', `可识别的动态执行或未解析目标：${found.dynamic.join(', ')}`);
      if (found.network.length) { mark('ask', '工具尝试联网'); result.network.push(...found.network); }
      for (const item of found.accesses) await path(item.action, item.path);
      for (const script of found.scripts) {
        const file = await path('read', script.path);
        if (result.decision === 'deny') continue;
        if (extname(file) !== '.py') { mark('ask', '执行非 Python 或无扩展名脚本'); continue; }
        const source = await this.readScript(file);
        result.scripts.push({ path: file, hash: digest(source) }); await analyze(source, 'python', depth + 1, script.cwd, file);
      }
      for (const code of found.sources) await analyze(code.source, 'python', depth + 1, code.cwd);
      for (const command of found.commands) await analyze(command.source, 'shell', depth + 1, command.cwd);
    };
    if (operation.name === 'bash') await analyze(operation.command, 'shell');
    else if (operation.name !== 'ask_clarification') await path(operation.name === 'write' || operation.name === 'edit' ? 'write' : 'read', operation.path);
    result.fingerprint = digest({ rules: 1, workspace, cwd, operation, paths: result.paths, scripts: result.scripts, network: result.network, reasons: result.reasons });
    return result;
  }
  private async readScript(file: string) {
    const handle = await open(file, 'r');
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('脚本不是普通文件或超过 256 KiB 检查上限');
      const buffer = Buffer.alloc(Math.min(stat.size + 1, 256 * 1024 + 1)); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 256 * 1024) throw new Error('脚本检查超限'); return buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
  }
  private async analyze(source: string, mode: 'shell' | 'python', cwd: string, file?: string) {
    return new Promise<z.infer<typeof inspectSchema>>((resolve, reject) => {
      const child = execFile(this.runtime.python, ['-I', '-B', join(this.runtime.helpers, 'inspect_policy.py')], { timeout: 3000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } }, (error, stdout) => {
        if (error) { reject(new Error('命令检查器失败，已阻止执行')); return; }
        try { resolve(inspectSchema.parse(JSON.parse(stdout))); } catch { reject(new Error('命令检查器响应无效，已阻止执行')); }
      });
      child.stdin?.on('error', () => {}); child.stdin?.end(JSON.stringify({ mode, source, cwd, file }));
    });
  }
}
