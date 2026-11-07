import { z } from 'zod';
import { MAX_INPUT_BYTES, type SelectedFile } from '../../../shared/models';
export const draftSchema = z.object({
  text: z.string().max(100_000),
  revision: z.number().int().nonnegative(),
  inputId: z.string().uuid(),
  files: z
    .array(z.object({ path: z.string(), name: z.string(), size: z.number(), token: z.string() }))
    .max(100),
  parent: z.string().optional(),
});
export type Draft = z.infer<typeof draftSchema>;
export const emptyDraft = (): Draft => ({
  text: '',
  revision: 0,
  inputId: crypto.randomUUID(),
  files: [],
});
export function editText(draft: Draft, text: string): Draft {
  return { ...draft, text, revision: draft.revision + 1, inputId: crypto.randomUUID() };
}
export function addFiles(draft: Draft, files: SelectedFile[]): Draft {
  const paths = new Set(draft.files.map((f) => f.path));
  const merged = [
    ...draft.files,
    ...files
      .filter((f) => {
        if (paths.has(f.path)) return false;
        paths.add(f.path);
        return true;
      })
      .map((file) => ({ ...file, token: crypto.randomUUID() })),
  ];
  if (merged.reduce((sum, file) => sum + file.size, 0) > MAX_INPUT_BYTES)
    throw new Error('所选文件总量不能超过 100 MB');
  if (merged.length > 100) throw new Error('最多选择 100 个文件');
  return { ...draft, inputId: crypto.randomUUID(), files: merged };
}
/** Acknowledgement clears only the accepted text revision and attachment instances. */
export function acknowledge(current: Draft, submitted: Draft): Draft {
  const tokens = new Set(submitted.files.map((f) => f.token));
  return {
    ...current,
    inputId: crypto.randomUUID(),
    text: current.revision === submitted.revision ? '' : current.text,
    files: current.files.filter((f) => !tokens.has(f.token)),
  };
}
