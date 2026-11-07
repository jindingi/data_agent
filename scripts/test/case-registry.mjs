export const nativeIds = [
  'R-WRITES',
  'P6-OUTPUT-LIMIT',
  'P6-LOG-LIMIT',
  'P6-DELETE-STORAGE',
  'P6-LOG-STORAGE',
  'P6-READ-ENCODING',
  'P4-ARTIFACT',
  'P4-VERSIONS',
  'P3-TOOLS',
  'P3-POLICY',
  'P3-READ-POLICY',
  'P3-NETWORK',
  'P3-CANCEL',
  'P1-SCHEMA',
  'P1-TREE',
  'P1-RECOVERY',
  'P1-COORDINATION',
  'P2-STREAM',
  'P2-SNAPSHOT',
  'P2-IDENTITY',
  'P2-CREDENTIAL',
  'P2-READ-BOUNDS',
  'P2-PREFLIGHT',
  'P2-REQUEST-LIMIT',
];

const packaged = new Set([
  'P0-PACKAGE',
  'P3-RUNTIME',
  'P7-THEME-INPUT',
  'P7-CDP',
  'P7-OFFLINE',
  'P7-LIVE',
  'P7-PACKAGE',
  'P7-DEFAULTS',
  'P7-ALL',
]);
const live = new Set(['P2-LIVE-READ', 'P3-LIVE-TOOLS', 'P4-LIVE', 'P7-LIVE']);
export function mergeCases(...groups) {
  const cases = {};
  for (const group of groups)
    for (const [id, run] of Object.entries(group)) {
      if (id in cases || typeof run !== 'function')
        throw new Error(`Duplicate or invalid case: ${id}`);
      cases[id] = run;
    }
  return cases;
}
export function requirementsFor(ids) {
  return {
    build: ids.some((id) => !nativeIds.includes(id) && !['P0-CHECK', 'P0-DEV'].includes(id)),
    packaged: ids.some((id) => packaged.has(id)),
    live: ids.some((id) => live.has(id)),
  };
}
