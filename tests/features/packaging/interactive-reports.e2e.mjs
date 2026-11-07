import { htmlPreviewScenario } from '../../support/html-preview-scenario.mjs';
export const cases = {
  'packaging.interactive-reports': (context) => htmlPreviewScenario(context, true),
};
