function openAIVideoError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, type: 'invalid_request_error' } }, { status });
}

export function videoInvalidRequest(message: string): Response {
  return openAIVideoError(400, 'invalid_request', message);
}

export function videoForbidden(): Response {
  return openAIVideoError(403, 'video_forbidden', 'Video job does not belong to this caller');
}

export function videoNotFound(): Response {
  return openAIVideoError(404, 'video_not_found', 'Video job not found');
}

export function videoCapabilityNotSupported(): Response {
  return openAIVideoError(501, 'video_capability_not_supported', 'This Videos port is not implemented');
}

export function videoUpstreamUnavailable(): Response {
  return openAIVideoError(503, 'video_upstream_unavailable', 'Pinned Videos provider is unavailable');
}

export function videoStoreFull(): Response {
  return openAIVideoError(503, 'video_store_full', 'Videos job store is full');
}
