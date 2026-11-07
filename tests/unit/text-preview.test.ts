import { afterEach, expect, it } from 'vitest';
import { mkdtemp, realpath, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inputTextPreview,
  textPreview,
  TEXT_PREVIEW_BYTES,
} from '../../src/main/services/text-preview';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('bounds text previews by bytes and lines without corrupting split UTF-8 characters', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'preview-')));
  roots.push(root);
  const text = 'a'.repeat(TEXT_PREVIEW_BYTES - 1) + '中文\nLAST';
  const path = join(root, 'large.csv');
  await writeFile(path, text);
  const preview = await inputTextPreview(path, []);
  expect(preview.truncated).toBe(true);
  expect(preview.text).toBe('a'.repeat(TEXT_PREVIEW_BYTES - 1));
  const lines = Buffer.from('中文\n'.repeat(3000));
  expect(textPreview(lines, lines.length, 'data.csv').text?.split('\n')).toHaveLength(2000);
  expect(textPreview(Buffer.from([0xff]), 1, 'data.csv').text).toBeUndefined();
  expect(textPreview(Buffer.from([0]), 1, 'binary.py').text).toBeUndefined();
  expect(textPreview(Buffer.alloc(0), 0, 'empty.csv').text).toBe('');
});
it('rejects sensitive files, redirected paths and directories', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'preview-')));
  roots.push(root);
  const path = join(root, 'input.csv');
  await writeFile(path, 'secret');
  await expect(inputTextPreview(path, [root])).rejects.toThrow('敏感目录');
  await symlink(path, join(root, 'link.csv'));
  await expect(inputTextPreview(join(root, 'link.csv'), [])).rejects.toThrow('路径已变更');
  await mkdir(join(root, '.ssh'));
  await writeFile(join(root, '.ssh/key.csv'), 'secret');
  await expect(inputTextPreview(join(root, '.ssh/key.csv'), [])).rejects.toThrow('敏感目录');
  await expect(inputTextPreview(root, [])).rejects.toThrow('普通文件');
});
