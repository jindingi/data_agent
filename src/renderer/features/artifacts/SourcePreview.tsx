import { useMemo } from 'react';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import sql from 'highlight.js/lib/languages/sql';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import r from 'highlight.js/lib/languages/r';
import ini from 'highlight.js/lib/languages/ini';
import type { TextPreview } from '../../../shared/file-preview';

for (const [name, grammar] of Object.entries({
  python,
  javascript,
  typescript,
  sql,
  json,
  yaml,
  bash,
  css,
  xml,
  markdown,
  r,
  ini,
}))
  hljs.registerLanguage(name, grammar);

export function SourcePreview({ preview }: { preview: TextPreview }) {
  const text = preview.text ?? '';
  const highlighted = useMemo(() => {
    if (!preview.language || !hljs.getLanguage(preview.language) || text.length > 32 * 1024)
      return null;
    try {
      // Only the library's escaped, locally generated token markup enters this HTML sink.
      return hljs.highlight(text, { language: preview.language, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [text, preview.language]);
  return (
    <>
      {preview.notice && (
        <p className="artifact-notice" role="status">
          {preview.notice}
        </p>
      )}
      {text.length > 32 * 1024 && preview.language !== 'plaintext' && (
        <p className="artifact-notice">内容较长，已使用纯文本显示以保持流畅。</p>
      )}
      {preview.text !== undefined &&
        (text.length ? (
          <div className="source-preview" tabIndex={0} aria-label="只读文件内容">
            <pre className="source-lines" aria-hidden="true">
              {Array.from({ length: text.split('\n').length }, (_, index) => index + 1).join('\n')}
            </pre>
            <pre className="source-code">
              <code>
                {highlighted === null ? (
                  text
                ) : (
                  <span dangerouslySetInnerHTML={{ __html: highlighted }} />
                )}
              </code>
            </pre>
          </div>
        ) : (
          <p className="artifact-notice">文件为空。</p>
        ))}
    </>
  );
}
