import { env } from '../../config/env';
import { UpstreamError } from '../../lib/errors';
import { supabase } from '../../lib/supabase';
import { toVectorLiteral } from '../../lib/vector';
import type { ChunkMatch } from '../../types';
import { getEmbeddingsProvider } from '../embeddings/provider';

export interface RetrievalResult {
  chunks: ChunkMatch[];
  topSimilarity: number;
}

// Embed the query and pull the nearest knowledge chunks via match_chunks().
// topSimilarity is the best cosine similarity found (0 when nothing matched),
// used downstream as the retrieval-confidence signal for escalation.
export async function retrieve(query: string): Promise<RetrievalResult> {
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
}
