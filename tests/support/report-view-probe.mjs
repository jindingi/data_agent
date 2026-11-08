import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Observe the actual native view in isolated test processes, without product IPC or report access.
// Chromium visibilityState/viewport dimensions can stay unchanged after setVisible(false).
export function reportViewProbe(root) {
  mkdirSync(root, { recursive: true });
  const hook = join(root, 'report-view-probe.cjs');
  const state = join(root, 'report-view-state.json');
  writeFileSync(
    hook,
    `if (process.versions.electron && process.type === 'browser') setImmediate(() => {
  const { WebContentsView } = require('electron');
  const { writeFileSync, renameSync } = require('node:fs');
  const original = WebContentsView.prototype.setVisible;
  WebContentsView.prototype.setVisible = function(value) {
    const result = original.call(this, value);
    writeFileSync(${JSON.stringify(`${state}.tmp`)}, JSON.stringify({
      visible: this.getVisible(), bounds: this.getBounds()
    }));
    renameSync(${JSON.stringify(`${state}.tmp`)}, ${JSON.stringify(state)});
    return result;
  };
});
`,
  );
  return {
    nodeOptions: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(hook)}`.trim(),
    matches(visible) {
      if (!existsSync(state)) return false;
      const value = JSON.parse(readFileSync(state, 'utf8'));
      return (
        value.visible === visible &&
        (!visible || (value.bounds.width > 100 && value.bounds.height > 100))
      );
    },
  };
}
