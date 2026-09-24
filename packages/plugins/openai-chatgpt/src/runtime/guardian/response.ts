export function guardianResponse(decision: Record<string, string>, stream: boolean): Response {
  const decisionText = JSON.stringify(decision);
  const createdAt = Math.floor(Date.now() / 1000);
  const responseId = `resp_${crypto.randomUUID()}`;
  const messageId = `msg_${crypto.randomUUID()}`;
  const item = {
    id: messageId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: decisionText, annotations: [], logprobs: [] }],
  };
  const completed = {
    id: responseId,
    created_at: createdAt,
    completed_at: createdAt,
    object: 'response',
    model: 'codex-auto-review',
    status: 'completed',
    output_text: decisionText,
    output: [item],
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
  };
  if (!stream) return Response.json(completed);

  const { completed_at: _completedAt, ...created } = completed;
  const events = [
    {
      type: 'response.created',
      sequence_number: 0,
      response: { ...created, status: 'in_progress', output_text: '', output: [] },
    },
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 2,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta: decisionText,
      logprobs: [],
    },
    { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item },
    { type: 'response.completed', sequence_number: 4, response: completed },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
