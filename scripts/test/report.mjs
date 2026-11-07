import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function saveReport(dir, report) {
  report.finished = new Date().toISOString();
  report.total = report.cases.length;
  report.passed = report.cases.filter((item) => item.status === 'passed').length;
  report.failed =
    Number(Boolean(report.error)) + report.cases.filter((item) => item.status === 'failed').length;
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(report, null, 2));
  const escape = (value) =>
    String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  writeFileSync(
    join(dir, 'junit.xml'),
    `<testsuite name="features" tests="${report.total + Number(Boolean(report.error))}" failures="${report.failed}">${report.cases.map((item) => `<testcase name="${escape(item.id)}" time="${item.ms / 1000}">${item.status === 'failed' ? `<failure message="${escape(item.error)}"/>` : ''}</testcase>`).join('')}${report.error ? `<testcase name="runner"><failure message="${escape(report.error)}"/></testcase>` : ''}</testsuite>`,
  );
  writeFileSync(
    join(dir, 'report.md'),
    `# ${report.status}\n\n${report.error ? `Runner failed: ${report.error}\n\n` : ''}${report.cases.map((item) => `- ${item.id}: ${item.status}${item.error ? ` — ${item.error}` : ''}`).join('\n')}\n`,
  );
}
