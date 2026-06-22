import OpenAI from 'openai';
import { env } from '../../config/env';
import { UpstreamError } from '../../lib/errors';
import { withRetry } from '../../lib/retry';

// Embeddings behind a provider interface. The output dimension must match the
// knowledge_chunks.embedding column (vector(1536) for text-embedding-3-small).

export interface EmbeddingsProvider {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
  embedOne(text: string): Promise<number[]>;
}

function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500);
}

class OpenAiEmbeddingsProvider implements EmbeddingsProvider {
  readonly model = env.EMBEDDING_MODEL;
  private readonly client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return withRetry(
      async () => {
        try {
          const resp = await this.client.embeddings.create({ model: this.model, input: texts });
          // Preserve input order (the API returns an index per item).
          return resp.data
            .slice()
            .sort((a, b) => a.index - b.index)
            .map((d) => d.embedding);
        } catch (err) {
          const status = err instanceof OpenAI.APIError ? err.status : undefined;
          throw new UpstreamError('Embedding request failed', {
            statusCode: status ?? 502,
            retryable: isRetryableStatus(status),
            cause: err,
          });
        }
      },
      { retries: env.HTTP_MAX_RETRIES, label: 'embeddings.embed' },
    );
  }

  async embedOne(text: string): Promise<number[]> {
    const [vector] = await this.embed([text]);
    if (!vector) throw new UpstreamError('Embedding provider returned no vector', { retryable: false });
    return vector;
  }
}

let provider: EmbeddingsProvider | null = null;

export function getEmbeddingsProvider(): EmbeddingsProvider {
  if (provider) return provider;
  if (!env.OPENAI_API_KEY) {
    throw new UpstreamError('Embeddings are not configured (OPENAI_API_KEY missing)', { retryable: false });
  }
  switch (env.EMBEDDING_PROVIDER) {
    case 'openai':
      provider = new OpenAiEmbeddingsProvider();
      return provider;
    default:
      throw new UpstreamError(`Unsupported embedding provider: ${env.EMBEDDING_PROVIDER}`, {
        retryable: false,
      });
  }
}
