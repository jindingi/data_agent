import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const publicExampleRoot = '/__data_agent_examples__';
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** Prepare a publication copy only; installed sessions keep this prefix unchanged thereafter. */
export function publicExampleSnapshot(native, binding, authoringRoot) {
  if (!isAbsolute(authoringRoot) || authoringRoot === '/' || authoringRoot.endsWith('/'))
    throw new Error('Expected an explicit authoring directory');
  const normalize = (text) =>
    text
      .replaceAll(authoringRoot, (match, offset, source) => {
        const next = source[offset + match.length];
        return next === undefined || /[/\\\s"'`<>]/.test(next) ? publicExampleRoot : match;
      })
      .replaceAll('/private/tmp/', `${publicExampleRoot}/temporary/`)
      .replaceAll('/tmp/', `${publicExampleRoot}/temporary/`);
  const publishedBinding = JSON.parse(normalize(JSON.stringify(binding)));
  publishedBinding.fingerprint = hash(
    JSON.stringify({ config: publishedBinding.config, skills: publishedBinding.skills }),
  );
  const publishedNative = Buffer.from(
    normalize(native.toString('utf8')).replaceAll(
      binding.fingerprint,
      publishedBinding.fingerprint,
    ),
  );
  return { native: publishedNative, binding: publishedBinding };
}

/** Unknown machine paths must fail review rather than being silently removed. */
export function assertPublicExampleFile(relative, bytes) {
  if (
    !relative.endsWith('.png') &&
    /\/(?:Users|Volumes|home)\/|\/(?:private\/(?:tmp|var)|tmp)\/|sk-[A-Za-z0-9_-]{20,}/.test(
      bytes.toString('utf8'),
    )
  )
    throw new Error(`Private path or possible credential in ${relative}`);
}
