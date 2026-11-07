/** Replace known paths even when a provider splits them across multiple SSE deltas.
 * Keep every event and all unrelated deltas; put each placeholder wholly in its first fragment.
 */
export function portableSse(text, bindings) {
  const frames = text.split(/(?<=\n\n)/).map((raw) => {
    const match = /^data: (\{[^]*\})\n\n$/.exec(raw);
    return match ? { raw, event: JSON.parse(match[1]) } : { raw };
  });
  const streams = new Map();
  const add = (key, object, field) => {
    if (typeof object?.[field] !== 'string') return;
    if (!streams.has(key)) streams.set(key, []);
    streams.get(key).push({ object, field });
  };
  for (const { event } of frames)
    for (const choice of event?.choices ?? []) {
      const key = String(choice.index ?? 0),
        delta = choice.delta;
      for (const field of ['content', 'reasoning_content', 'reasoning'])
        add(`${key}:${field}`, delta, field);
      for (const call of delta?.tool_calls ?? []) {
        for (const field of ['arguments', 'name'])
          add(`${key}:tool:${call.index}:${field}`, call.function, field);
      }
    }
  for (const refs of streams.values()) {
    for (const [key, value] of Object.entries(bindings).sort((a, b) => b[1].length - a[1].length)) {
      if (!value) throw new Error('Empty path binding');
      const values = refs.map((ref) => ref.object[ref.field]),
        joined = values.join('');
      const positions = [];
      for (let at = joined.indexOf(value); at >= 0; at = joined.indexOf(value, at + value.length))
        positions.push(at);
      // Reverse edits preserve offsets for earlier occurrences, including two in the same fragment.
      for (const start of positions.reverse()) {
        const end = start + value.length;
        let offset = 0;
        for (let i = 0; i < values.length; i++) {
          const length = refs[i].object[refs[i].field].length;
          const low = Math.max(start, offset),
            high = Math.min(end, offset + length);
          if (low < high)
            values[i] =
              values[i].slice(0, low - offset) +
              (low === start ? `{{${key}}}` : '') +
              values[i].slice(high - offset);
          offset += length;
        }
      }
      refs.forEach((ref, i) => {
        ref.object[ref.field] = values[i];
      });
    }
  }
  return frames.map(({ raw, event }) => (event ? `data: ${JSON.stringify(event)}\n\n` : raw));
}
