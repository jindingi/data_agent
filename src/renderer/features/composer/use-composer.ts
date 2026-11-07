import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { RunInput } from '../../../shared/runtime';
import type { SelectedFile } from '../../../shared/models';
import { request } from '../../lib/desktop';
import { draftSchema, emptyDraft, editText, addFiles, acknowledge, type Draft } from './drafts';
const storageKey = 'composer-drafts-v1';
function read(): Record<string, Draft> {
  try {
    return z
      .record(z.string(), draftSchema)
      .parse(JSON.parse(localStorage.getItem(storageKey) ?? '{}'));
  } catch {
    return {};
  }
}
export function useComposer(
  sessionId: string | null,
  onAccepted: (id: string, origin: string | null) => void,
  onError: (message: string) => void,
) {
  const [drafts, setDrafts] = useState(read);
  const store = useRef(drafts);
  const fallback = useRef(emptyDraft());
  const pending = useRef(new Set<string>());
  const [sending, setSending] = useState<string[]>([]);
  const selection = useRef(sessionId);
  useEffect(() => {
    selection.current = sessionId;
  }, [sessionId]);
  const key = sessionId ?? 'home';
  const draft = drafts[key] ?? fallback.current;
  const write = (update: (current: Record<string, Draft>) => Record<string, Draft>) => {
    const next = update(store.current);
    // Persist before updating the UI, so a reload cannot silently lose a pending draft.
    localStorage.setItem(storageKey, JSON.stringify(next));
    store.current = next;
    setDrafts(next);
  };
  const change = (update: (draft: Draft) => Draft) =>
    write((current) => ({ ...current, [key]: update(current[key] ?? fallback.current) }));
  async function attach(files: SelectedFile[]) {
    // Validate only new selections; a late response must not restore files removed meanwhile.
    const checked = await request({ type: 'files.inspect', paths: files.map((f) => f.path) });
    change((value) => addFiles(value, checked));
  }
  async function pickFiles() {
    const files = await request({ type: 'files.choose' });
    if (files.length) await attach(files);
  }
  async function dropFiles(files: File[]) {
    const result = await window.dataAgent.inspectDroppedFiles(files);
    if (!result.ok) throw new Error(result.error.message);
    await attach(result.value);
  }
  async function chooseWorkspace() {
    const parent = await request({ type: 'workspace.choose' });
    if (parent) change((value) => ({ ...value, parent, inputId: crypto.randomUUID() }));
  }
  async function send(kind: RunInput['kind']) {
    const submitted = store.current[key] ?? fallback.current;
    if (!submitted.text.trim() || pending.current.has(key)) return;
    pending.current.add(key);
    setSending([...pending.current]);
    try {
      const value = await request({
        type: 'conversation.submit',
        sessionId: sessionId ?? undefined,
        parent: sessionId ? undefined : submitted.parent,
        input: {
          inputId: submitted.inputId,
          kind,
          text: submitted.text,
          paths: submitted.files.map((file) => file.path),
        },
      });
      write((current) => {
        const remaining = acknowledge(current[key] ?? submitted, submitted);
        return !sessionId && selection.current === null
          ? { ...current, home: emptyDraft(), [value.sessionId]: remaining }
          : { ...current, [key]: remaining };
      });
      onAccepted(value.sessionId, sessionId);
    } catch (error) {
      onError(error instanceof Error ? error.message : '无法发送');
    } finally {
      pending.current.delete(key);
      setSending([...pending.current]);
    }
  }
  return {
    draft,
    sending: sending.includes(key),
    setText: (text: string) => change((value) => editText(value, text)),
    removeFile: (token: string) =>
      change((value) => ({
        ...value,
        inputId: crypto.randomUUID(),
        files: value.files.filter((file) => file.token !== token),
      })),
    pickFiles,
    dropFiles,
    chooseWorkspace,
    forget: (sessionId: string) =>
      write((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      }),
    send,
    restore: async (input: RunInput) => {
      const files = await request({ type: 'files.inspect', paths: input.paths ?? [] });
      change((value) => addFiles(editText(value, input.text), files));
    },
  };
}
