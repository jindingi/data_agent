import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSource } from '../../scripts/test/dependency-boundaries.mjs';

test('relative, aliased, dynamic imports and re-exports obey process boundaries', () => {
  const file = 'src/renderer/app/App.tsx';
  assert.deepEqual(checkSource(file, "import { x } from '../../shared/runtime';"), []);
  for (const statement of [
    "import { x } from '../../main/index';",
    "import { x } from '@/../main/index';",
    "export { x } from '@/../main/index';",
    "const x = import('@/../main/index');",
    "const x = require('node:fs');",
  ])
    assert(checkSource(file, statement).length > 0, statement);
  assert(checkSource('src/main/index.ts', "import { request } from '@/lib/desktop';").length > 0);
});
