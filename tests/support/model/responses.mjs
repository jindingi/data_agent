/** Minimal protocol fixture, consumed by the actual pi Responses parser. */
export function responsesSse(model, reply, id = 'fixture') {
  const events = [];
  let sequence = 0;
  const send = (type, fields) =>
    events.push(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`,
    );
  send('response.created', { response: { id, status: 'in_progress' } });
  const output = [];
  for (const [index, tool] of (reply.tools ?? (reply.tool ? [reply.tool] : [])).entries()) {
    const item = {
      type: 'function_call',
      id: `fc_${id}_${index}`,
      call_id: `call_${id}_${index}`,
      name: tool.name,
      arguments: JSON.stringify(tool.args),
      status: 'completed',
    };
    send('response.output_item.added', {
      output_index: index,
      item: { ...item, arguments: '', status: 'in_progress' },
    });
    const cut = Math.floor(item.arguments.length / 2);
    for (const delta of [item.arguments.slice(0, cut), item.arguments.slice(cut)])
      send('response.function_call_arguments.delta', {
        output_index: index,
        item_id: item.id,
        delta,
      });
    send('response.output_item.done', { output_index: index, item });
    output.push(item);
  }
  if (!output.length) {
    const item = {
      type: 'message',
      id: `msg_${id}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: reply.text ?? 'Done', annotations: [] }],
    };
    send('response.output_item.added', {
      output_index: 0,
      item: { ...item, content: [], status: 'in_progress' },
    });
    send('response.output_text.delta', {
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      delta: item.content[0].text,
    });
    send('response.output_item.done', { output_index: 0, item });
    output.push(item);
  }
  send('response.completed', {
    response: {
      id,
      status: 'completed',
      model,
      output,
      usage: reply.usage ?? {
        input_tokens: 100,
        output_tokens: 10,
        input_tokens_details: { cached_tokens: 20 },
        total_tokens: 110,
      },
    },
  });
  return events.join('');
}
