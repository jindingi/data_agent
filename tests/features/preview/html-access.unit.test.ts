import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceFileService } from '../../../src/main/services/workspace';
import { HTML_REPORT_MAX_BYTES } from '../../../src/shared/html-report';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
it('reads complete bounded UTF-8 HTML and rejects invalid, replaced and cross-session entries', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'report-access-')));
  roots.push(root);
  const service = new WorkspaceFileService({ get: () => ({ workspace: root }) }, [], () => false);
  const file = join(root, 'report.html');
  const text = '<!doctype html>' + '中'.repeat(60000);
  writeFileSync(file, text);
  const entry = (await service.list('one')).entries[0];
  expect(await service.html('one', entry.id)).toBe(text);
  expect((await service.preview('one', entry.id)).truncated).toBe(true);
  await expect(service.html('two', entry.id)).rejects.toThrow();
  writeFileSync(file, Buffer.from([255]));
  const invalid = (await service.list('one')).entries[0];
  await expect(service.html('one', invalid.id)).rejects.toThrow('UTF-8');
  truncateSync(file, HTML_REPORT_MAX_BYTES + 1);
  const huge = (await service.list('one')).entries[0];
  await expect(service.html('one', huge.id)).rejects.toThrow('32 MiB');
  rmSync(file);
  symlinkSync('/etc/hosts', file);
  await expect(service.html('one', entry.id)).rejects.toThrow();
});
