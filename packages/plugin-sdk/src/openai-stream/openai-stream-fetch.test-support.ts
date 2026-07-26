export const encoder = new TextEncoder();

export const compressionFormats = {
  gzip: 'gzip',
  deflate: 'deflate',
  br: 'brotli',
  zstd: 'zstd',
} as const satisfies Record<string, Bun.CompressionFormat>;

const BunCompressionStream = CompressionStream as unknown as {
  new (format: Bun.CompressionFormat): CompressionStream;
};

export async function compress(encoding: keyof typeof compressionFormats, payload: Uint8Array): Promise<Uint8Array> {
  const stream = new BunCompressionStream(compressionFormats[encoding]);
  const writer = stream.writable.getWriter();
  await writer.write(payload);
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

export const responsesTerminal = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
