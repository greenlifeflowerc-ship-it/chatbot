import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { env } from '../../config/env';
import { UpstreamError } from '../../lib/errors';
import { llmLimiter } from '../../lib/limiters';
import { nativeFetch } from '../../lib/nativeFetch';
import { withRetry } from '../../lib/retry';

// LLM generation behind a provider interface so the model vendor is swappable
// via env. Generation is text-in/text-out; structured parsing (answer +
// confidence) lives in the RAG layer, keeping this interface minimal.

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  // Image URLs attached to the latest user turn (handled by vision-capable
  // providers; ignored otherwise).
  imageUrls?: string[];
  maxTokens?: number;
  temperature?: number;
}

export interface LlmProvider {
  readonly model: string;
  complete(request: LlmRequest): Promise<string>;
}

function isRetryableStatus(status: number | undefined): boolean {
  // No status => a network/transport error (e.g. "Premature close"). Transient,
  // so retry it. With a status, only 429 and 5xx are worth retrying.
  if (status === undefined) return true;
  return status === 429 || status >= 500;
}

class AnthropicProvider implements LlmProvider {
  readonly model = env.LLM_MODEL;
  private readonly client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  async complete(request: LlmRequest): Promise<string> {
    return llmLimiter(() =>
      withRetry(
        async () => {
          try {
            const resp = await this.client.messages.create({
              model: this.model,
              max_tokens: request.maxTokens ?? 1024,
              temperature: request.temperature ?? 0.2,
              system: request.system,
              messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
            });

            return resp.content
              .filter((block): block is Anthropic.TextBlock => block.type === 'text')
              .map((block) => block.text)
              .join('')
              .trim();
          } catch (err) {
            const status = err instanceof Anthropic.APIError ? err.status : undefined;
            throw new UpstreamError('LLM completion failed', {
              statusCode: status ?? 502,
              retryable: isRetryableStatus(status),
              cause: err,
            });
          }
        },
        { retries: env.HTTP_MAX_RETRIES, label: 'llm.complete' },
      ),
    );
  }
}

// Groq is OpenAI-compatible — same chat-completions shape at a different base URL.
class GroqProvider implements LlmProvider {
  readonly model = env.GROQ_MODEL;
  private readonly client = new OpenAI({
    apiKey: env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
    // Native fetch (undici) avoids node-fetch "Premature close" on gzipped
    // responses; nativeFetch adds the duplex option needed for uploads.
    fetch: nativeFetch,
  });

  async complete(request: LlmRequest): Promise<string> {
    const images = request.imageUrls ?? [];
    const hasImages = images.length > 0;
    // When an image is present, use the vision model so it sees the picture and
    // the customer's question together (the question is the latest user turn).
    const model = hasImages ? env.GROQ_VISION_MODEL : this.model;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: request.system },
    ];
    request.messages.forEach((m, i) => {
      const isLastUser = i === request.messages.length - 1 && m.role === 'user';
      if (isLastUser && hasImages) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: m.content || 'Please look at the image.' },
            ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
          ],
        });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    });
    if (hasImages && !request.messages.some((m) => m.role === 'user')) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: 'Please look at the image.' },
          ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ],
      });
    }

    return llmLimiter(() =>
      withRetry(
        async () => {
          try {
            const resp = await this.client.chat.completions.create({
              model,
              max_tokens: request.maxTokens ?? 1024,
              temperature: request.temperature ?? 0.2,
              messages,
            });
            return (resp.choices[0]?.message?.content ?? '').trim();
          } catch (err) {
            const status = err instanceof OpenAI.APIError ? err.status : undefined;
            throw new UpstreamError('LLM completion failed', {
              statusCode: status ?? 502,
              retryable: isRetryableStatus(status),
              cause: err,
            });
          }
        },
        { retries: env.HTTP_MAX_RETRIES, label: 'llm.groq.complete' },
      ),
    );
  }
}

let provider: LlmProvider | null = null;

export function getLlmProvider(): LlmProvider {
  if (provider) return provider;
  switch (env.LLM_PROVIDER) {
    case 'anthropic':
      if (!env.ANTHROPIC_API_KEY) {
        throw new UpstreamError('LLM is not configured (ANTHROPIC_API_KEY missing)', { retryable: false });
      }
      provider = new AnthropicProvider();
      return provider;
    case 'groq':
      if (!env.GROQ_API_KEY) {
        throw new UpstreamError('LLM is not configured (GROQ_API_KEY missing)', { retryable: false });
      }
      provider = new GroqProvider();
      return provider;
    default:
      throw new UpstreamError(`Unsupported LLM provider: ${env.LLM_PROVIDER}`, { retryable: false });
  }
}
