import { expect, it } from 'vitest';
import { textPreview, TEXT_PREVIEW_BYTES } from '../../../src/main/services/text-preview';
it('bounds text previews by bytes and lines without corrupting split UTF-8 characters', () => {
  const text = 'a'.repeat(TEXT_PREVIEW_BYTES - 1) + '中文\nLAST',
    bytes = Buffer.from(text);
  const preview = textPreview(bytes.subarray(0, TEXT_PREVIEW_BYTES), bytes.length, 'large.csv');
  expect(preview.truncated).toBe(true);
  expect(preview.text).toBe('a'.repeat(TEXT_PREVIEW_BYTES - 1));
  const lines = Buffer.from('中文\n'.repeat(3000));
  expect(textPreview(lines, lines.length, 'data.csv').text?.split('\n')).toHaveLength(2000);
  expect(textPreview(Buffer.from([0xff]), 1, 'data.csv').text).toBeUndefined();
  expect(textPreview(Buffer.from([0]), 1, 'binary.py').text).toBeUndefined();
  expect(textPreview(Buffer.alloc(0), 0, 'empty.csv').text).toBe('');
  expect(textPreview(Buffer.from('unknown'), 7, 'blob.bin').notice).toContain('暂不支持');
});
// File identity, sensitive paths, links and directory access are covered through
// the production WorkspaceFileService in workspace.access and preview.files.
