import { embeddingsEnabled, env } from '../../config/env';
import { UpstreamError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { supabase } from '../../lib/supabase';
import { toVectorLiteral } from '../../lib/vector';
import type { ChunkMatch } from '../../types';
import { getEmbeddingsProvider } from '../embeddings/provider';

export interface RetrievalResult {
  chunks: ChunkMatch[];
  topSimilarity: number;
}

// Pull knowledge-base context for a query. With embeddings configured this is a
// vector search; without them (e.g. a Groq-only setup) it falls back to
// including the knowledge text directly. topSimilarity is the retrieval-
// confidence signal used for escalation.
export async function retrieve(query: string): Promise<RetrievalResult> {
  if (!embeddingsEnabled) return retrieveWithoutEmbeddings();

  try {
    const embeddings = getEmbeddingsProvider();
    const vector = await embeddings.embedOne(query);

    const { data, error } = await supabase.rpc('match_chunks', {
      query_embedding: toVectorLiteral(vector),
      match_count: env.RAG_TOP_K,
      min_similarity: env.RAG_MIN_SIMILARITY,
    });
    if (error) throw new UpstreamError('vector search failed', { retryable: true, cause: error });

    const chunks = (data as ChunkMatch[]) ?? [];
    const topSimilarity = chunks.length > 0 ? Math.max(...chunks.map((c) => c.similarity)) : 0;
    return { chunks, topSimilarity };
  } catch (err) {
    // A bad/expired embeddings key or vector error should not take down the bot —
    // degrade to including the knowledge text directly so generation still runs.
    logger.warn({ err }, 'embeddings/vector search failed; falling back to direct knowledge text');
    return retrieveWithoutEmbeddings();
  }
}

// No vector search: include the most recent knowledge chunks directly. Similarity
// is reported as 1 so the low-confidence escalation rule does not fire — the
// model's can_answer signal decides instead.
async function retrieveWithoutEmbeddings(): Promise<RetrievalResult> {
  const { data, error } = await supabase
    .from('knowledge_chunks')
    .select('id, content')
    .order('created_at', { ascending: false })
    .limit(12);
  if (error) throw new UpstreamError('failed to load knowledge chunks', { retryable: true, cause: error });

  const chunks = ((data as Array<{ id: string; content: string }>) ?? []).map((c) => ({
    id: c.id,
    content: c.content,
    similarity: 1,
  }));
  return { chunks, topSimilarity: 1 };
}
