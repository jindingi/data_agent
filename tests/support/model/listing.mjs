/** Synthetic discovery setup, independent from completion fixtures/cassette exchanges. */
export function serveModelListing(request, response) {
  if (request.method !== 'GET' || request.url !== '/v1/models') return false;
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(
    JSON.stringify({
      data: [
        { id: 'deepseek-flash' },
        { id: 'deepseek-v4-pro' },
        { id: 'openai/gpt-4o-mini', supported_parameters: ['tools'] },
        { id: 'unknown-new-model', supported_parameters: ['tools'] },
      ],
    }),
  );
  return true;
}
