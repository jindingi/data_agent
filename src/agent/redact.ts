/** Redact the selected credential before events leave the Host or messages enter JSONL. */
export function redactor(secret: string) {
  function redact<T>(value: T): T {
    if (typeof value === 'string') return value.replaceAll(secret, '[REDACTED]') as T;
    if (Array.isArray(value)) return value.map(item => redact(item)) as T;
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)])) as T;
    return value;
  }
  return redact;
}
