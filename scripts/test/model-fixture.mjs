import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/** Scripted HTTP transport only: actual pi SDK, IPC, tools and UI remain in use. */
export async function modelFixture() {
  const requests = [], replies = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body); requests.push(payload);
    const reply = replies.shift();
    if (!reply) { response.writeHead(500); response.end('Fixture response queue exhausted'); return; }
    const id = randomUUID(), created = Math.floor(Date.now() / 1000);
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: payload.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant', reasoning_content: 'Checking the requested operation through the workbench tools.' });
    if (reply.tool) {
      send({ tool_calls: [{ index: 0, id: `call_${randomUUID()}`, type: 'function', function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] });
      send({}, 'tool_calls');
    } else { send({ content: reply.text ?? 'Fixture task finished.' }); send({}, 'stop'); }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests,
    set: (...values) => { replies.splice(0, replies.length, ...values); },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}
