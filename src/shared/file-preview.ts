export interface TextPreview {
  text?: string;
  language?: string;
  truncated?: boolean;
  notice?: string;
}

export function previewLanguage(name: string): string | undefined {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return (
    {
      py: 'python',
      js: 'javascript',
      jsx: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      sql: 'sql',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      sh: 'bash',
      bash: 'bash',
      css: 'css',
      html: 'xml',
      xml: 'xml',
      md: 'markdown',
      markdown: 'markdown',
      csv: 'plaintext',
      tsv: 'plaintext',
      txt: 'plaintext',
      log: 'plaintext',
      r: 'r',
      toml: 'ini',
      ini: 'ini',
    } as Record<string, string>
  )[extension];
}
