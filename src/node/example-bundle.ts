import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, sep, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { verifyBinding } from './agent-config-resources';
import { inspectSessionFile } from './session-integrity';

const relativeFile = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (path) =>
      !path.includes('\\') &&
      !path.includes('\0') &&
      path.split('/').every((p) => p && p !== '.' && p !== '..'),
  );
export const exampleCatalogSchema = z
  .object({
    version: z.literal(1),
    files: z.record(
      relativeFile,
      z
        .object({
          bytes: z
            .number()
            .int()
            .positive()
            .max(32 * 1024 * 1024),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    examples: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            title: z.string().min(1).max(100),
            directory: relativeFile,
            report: relativeFile,
            runId: z.string().uuid(),
            createdAt: z.string().datetime(),
            inputs: z
              .array(
                z
                  .object({
                    inputId: z.string().uuid(),
                    runId: z.string().uuid(),
                    entryId: z.string().min(1),
                    kind: z.enum(['prompt', 'steer', 'followUp']),
                    digest: z.string().regex(/^[a-f0-9]{64}$/),
                  })
                  .strict(),
              )
              .min(1)
              .max(100),
          })
          .strict(),
      )
      .length(2),
  })
  .strict();
export type ExampleCatalog = z.infer<typeof exampleCatalogSchema>;
export const exampleHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Bundled, enumerated bytes only. No directory traversal, links, or unlisted file copies. */
export function readExampleBundle(root: string) {
  root = resolve(root);
  if (lstatSync(root).isSymbolicLink()) throw new Error('示例资源根不能是符号链接');
  root = realpathSync(root);
  const checkedPath = (path: string) => {
    const file = join(root, path);
    if (!file.startsWith(root + sep)) throw new Error('示例资源路径越界');
    for (let current = file; ; current = dirname(current)) {
      if (lstatSync(current).isSymbolicLink()) throw new Error('示例资源不能是符号链接');
      if (current === root) break;
    }
    if (realpathSync(file) !== file) throw new Error('示例资源路径已重定向');
    return file;
  };
  const manifest = checkedPath('catalog.json');
  if (lstatSync(manifest).size > 128 * 1024) throw new Error('示例清单过大');
  const catalog = exampleCatalogSchema.parse(JSON.parse(readFileSync(manifest, 'utf8')));
  if (
    Object.keys(catalog.files).length > 200 ||
    Object.values(catalog.files).reduce((n, f) => n + f.bytes, 0) > 64 * 1024 * 1024
  )
    throw new Error('示例资源超出限额');
  if (
    new Set(catalog.examples.map((e) => e.id)).size !== 2 ||
    new Set(catalog.examples.map((e) => e.directory)).size !== 2
  )
    throw new Error('示例身份重复');
  const files = new Map<string, Buffer>();
  for (const [path, expected] of Object.entries(catalog.files)) {
    const file = checkedPath(path);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size !== expected.bytes)
      throw new Error(`示例资源大小不符：${path}`);
    const bytes = readFileSync(file);
    if (exampleHash(bytes) !== expected.sha256) throw new Error(`示例资源校验失败：${path}`);
    files.set(path, bytes);
  }
  const examples = catalog.examples.map((item) => {
    const file = `${item.directory}/session.jsonl`;
    const bindingBytes = files.get(`${item.directory}/agent-binding.json`);
    if (
      !files.has(file) ||
      !bindingBytes ||
      !files.has(`${item.directory}/workspace/${item.report}`)
    )
      throw new Error('示例会话或报告缺失');
    const integrity = inspectSessionFile(join(root, file), null, true);
    if (integrity.state !== 'persisted') throw new Error(integrity.error ?? '示例会话损坏');
    const binding = verifyBinding(JSON.parse(bindingBytes.toString('utf8')));
    if (!binding.revision || binding.revision <= 1)
      throw new Error('示例修订必须保留本机初始默认修订');
    const entries = files
      .get(file)!
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    if (
      !entries.some(
        (e) =>
          e.type === 'custom' &&
          e.customType === 'data_agent.agent_config' &&
          e.data?.fingerprint === binding.fingerprint &&
          e.data?.revision === binding.revision,
      )
    )
      throw new Error('示例配置绑定缺失');
    for (const input of item.inputs)
      if (
        !entries.some(
          (e) => e.id === input.entryId && e.type === 'message' && e.message?.role === 'user',
        )
      )
        throw new Error('示例输入登记不匹配');
    return { ...item, binding, piSessionId: integrity.piSessionId! };
  });
  return { catalog, files, examples };
}
