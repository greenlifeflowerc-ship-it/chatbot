// Node's native fetch (undici) requires `duplex: 'half'` when the request body is
// a stream/FormData (e.g. multipart file uploads such as Whisper transcription).
// The OpenAI SDK doesn't set it, so wrap fetch to add it automatically. Using
// native fetch also avoids node-fetch's "Premature close" on gzipped responses.
type FetchInput = Parameters<typeof fetch>[0];

export const nativeFetch = ((input: FetchInput, init?: RequestInit) => {
  const i = init as (RequestInit & { body?: unknown; duplex?: string }) | undefined;
  if (i && i.body != null && typeof i.body !== 'string' && i.duplex == null) {
    return fetch(input, { ...init, duplex: 'half' } as RequestInit);
  }
  return fetch(input, init);
}) as typeof fetch;
