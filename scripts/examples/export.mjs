import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

// Run with Electron's Node ABI. Select only public example metadata, never app_metadata credentials.
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--source' || args[2] !== '--output')
  throw new Error('Expected --source <authoring-root> --output <new-resource-directory>');
const root = resolve(args[1]),
  output = resolve(args[3]);
if (existsSync(output)) throw new Error('Export target exists; review and use a new directory');
const tasks = JSON.parse(readFileSync(new URL('./tasks.json', import.meta.url), 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = {};
const put = (relative, bytes) => {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (
    !relative.endsWith('.png') &&
    /\/Users\/|\/Volumes\/|sk-[A-Za-z0-9_-]{20,}/.test(bytes.toString('utf8'))
  )
    throw new Error(`Private path or possible credential in ${relative}`);
  const target = join(output, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  files[relative] = { bytes: bytes.length, sha256: hash(bytes) };
};
const db = new Database(join(root, 'application/data/state.sqlite'), {
  readonly: true,
  fileMustExist: true,
});
const examples = [];
const provenance = [];
try {
  for (const task of tasks) {
    const evidence = JSON.parse(readFileSync(join(root, task.id, 'evidence.json'), 'utf8'));
    if (evidence.status !== 'completed') throw new Error(`Incomplete real task ${task.id}`);
    const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(evidence.sessionId);
    const binding = JSON.parse(
      db
        .prepare('SELECT snapshot FROM agent_config_revisions WHERE revision=?')
        .get(session.agent_config_revision).snapshot,
    );
    const native = readFileSync(session.session_file);
    const entries = native
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    if (!entries.some((e) => e.message?.role === 'assistant' && e.message?.usage?.totalTokens > 0))
      throw new Error('No actual provider usage');
    const inputs = db
      .prepare(
        "SELECT input_id AS inputId,run_id AS runId,kind,entry_id AS entryId,digest FROM input_submissions WHERE session_id=? AND state='committed' ORDER BY sequence",
      )
      .all(session.id);
    put(`${task.id}/session.jsonl`, native);
    put(`${task.id}/agent-binding.json`, JSON.stringify(binding, null, 2) + '\n');
    const walk = (dir, relative = '') => {
      for (const name of readdirSync(dir)) {
        if (
          name.startsWith('.') ||
          name === 'data' ||
          name === '__pycache__' ||
          name === '_portability_test' ||
          /\.(log|err)$/.test(name)
        )
          continue;
        const file = join(dir, name),
          path = relative ? `${relative}/${name}` : name,
          stat = lstatSync(file);
        if (stat.isSymbolicLink()) throw new Error('Linked workspace asset');
        if (stat.isDirectory()) walk(file, path);
        else if (stat.isFile()) put(`${task.id}/workspace/${path}`, readFileSync(file));
      }
    };
    walk(session.workspace);
    const csv = readFileSync(join(session.workspace, 'data/netflix_titles.csv'));
    if (hash(csv) !== 'df1f4ad2027a5a14c3a33932ef0d4054565ff88adf92b7f263601b70fdc6f3f3')
      throw new Error('Modified source');
    if (!files['datasets/netflix/netflix_titles.csv'])
      put('datasets/netflix/netflix_titles.csv', csv);
    examples.push({
      id: session.id,
      title: task.title,
      directory: task.id,
      report: task.report,
      runId: session.run_id,
      createdAt: session.created_at,
      inputs,
    });
    provenance.push({
      id: session.id,
      provider: 'deepseek',
      model: 'deepseek-flash',
      generatedAt: evidence.startedAt,
      commit: evidence.commit,
      sourceTreeHash: evidence.artifactsContext.fingerprint,
      skillFingerprint: binding.fingerprint,
      originalSessionSha256: hash(native),
      reportSha256: files[`${task.id}/workspace/${task.report}`].sha256,
      hadNetworkInterruption: entries.some(
        (e) => e.message?.errorMessage === 'net::ERR_NETWORK_CHANGED',
      ),
    });
  }
  put(
    'datasets/netflix/SOURCE.md',
    `# Netflix Movies and TV Shows\n\n作者：Shivam Bansal（Kaggle: shivamb）。\n\n来源：https://www.kaggle.com/datasets/shivamb/netflix-shows/data\n\n来源页许可：CC0: Public Domain，2026-11-08 核验。许可说明：https://creativecommons.org/publicdomain/zero/1.0/\n\n文件：netflix_titles.csv；SHA-256：df1f4ad2027a5a14c3a33932ef0d4054565ff88adf92b7f263601b70fdc6f3f3。\n\n这是用户提供的固定历史文件，8,807 条记录，最大有效上架日期 2021-09-25；不是 Netflix 当前片库或完整上下架历史。打包及安装不从 Kaggle 更新数据。原 CSV 不作清理改写；分析仅生成派生文件。\n`,
  );
  put(
    'provenance.json',
    JSON.stringify(
      {
        version: 1,
        source: 'https://www.kaggle.com/datasets/shivamb/netflix-shows/data',
        license: 'CC0-1.0',
        examples: provenance,
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(output, 'catalog.json'),
    JSON.stringify({ version: 1, files, examples }, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      output,
      examples: examples.map((e) => e.id),
      files: Object.keys(files).length,
    }),
  );
} finally {
  db.close();
}
