import { describe, it, expect } from 'vitest';
import {
  emptyDraft,
  editText,
  addFiles,
  acknowledge,
} from '../../src/renderer/features/composer/drafts';
const a = { path: '/a.csv', name: 'a.csv', size: 10 },
  b = { path: '/b.csv', name: 'b.csv', size: 20 };
describe('composer acknowledgement', () => {
  it('preserves edits and added attachments while clearing only accepted tokens', () => {
    const sent = addFiles(editText(emptyDraft(), 'first'), [a]);
    const later = addFiles(editText(sent, 'next question'), [b]);
    const result = acknowledge(later, sent);
    expect(result.text).toBe('next question');
    expect(result.files.map((f) => f.path)).toEqual(['/b.csv']);
    expect(result.inputId).not.toBe(sent.inputId);
  });
  it('does not clear a removed and reattached path or a retyped same text', () => {
    const sent = addFiles(editText(emptyDraft(), 'first'), [a]);
    const later = addFiles(editText({ ...sent, files: [] }, 'first'), [a]);
    const result = acknowledge(later, sent);
    expect(result.text).toBe('first');
    expect(result.files).toHaveLength(1);
  });
  it('enforces the aggregate limit against the latest draft without mutating it', () => {
    const current = addFiles(emptyDraft(), [{ ...a, size: 80_000_000 }]);
    expect(() => addFiles(current, [{ ...b, size: 30_000_000 }])).toThrow('100 MB');
    expect(current.files).toHaveLength(1);
    expect(addFiles(emptyDraft(), [a, a]).files).toHaveLength(1);
  });
  it('clears accepted snapshots and deduplicates original paths', () => {
    const sent = addFiles(addFiles(editText(emptyDraft(), 'first'), [a]), [a]);
    expect(sent.files).toHaveLength(1);
    const result = acknowledge(sent, sent);
    expect(result.text).toBe('');
    expect(result.files).toEqual([]);
  });
});
