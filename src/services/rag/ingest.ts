import { ValidationError, UpstreamError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { supabase } from '../../lib/supabase';
import { toVectorLiteral } from '../../lib/vector';
import { getEmbeddingsProvider } from '../embeddings/provider';

// Chunking targets ~500 tokens with ~50 token overlap, split on paragraph
// boundaries. Token counts are estimated at ~4 chars/token, which is accurate
// enough for sizing chunks (the real token_count is informational).
const CHARS_PER_TOKEN = 4;
const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 50;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;
const EMBED_BATCH = 64;

export interface Chunk {
  content: string;
  index: number;
  tokenCount: number;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

// Hard-split an oversized paragraph on sentence boundaries, falling back to a
// raw character slice if a single "sentence" is still too long.
function splitLongParagraph(paragraph: string): string[] {
  const sentences = paragraph.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) ?? [paragraph];
  const pieces: string[] = [];
  let buffer = '';
  for (const sentence of sentences) {
    if (sentence.length > TARGET_CHARS) {
      if (buffer) {
        pieces.push(buffer.trim());
        buffer = '';
      }
      for (let i = 0; i < sentence.length; i += TARGET_CHARS) {
        pieces.push(sentence.slice(i, i + TARGET_CHARS).trim());
      }
      continue;
    }
    if (buffer.length + sentence.length > TARGET_CHARS) {
      pieces.push(buffer.trim());
      buffer = sentence;
    } else {
      buffer += sentence;
    }
  }
  if (buffer.trim()) pieces.push(buffer.trim());
  return pieces.filter(Boolean);
}

export function chunkText(raw: string): Chunk[] {
  const paragraphs = raw
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const units: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length > TARGET_CHARS) units.push(...splitLongParagraph(paragraph));
    else units.push(paragraph);
  }

  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    if (current && current.length + unit.length + 2 > TARGET_CHARS) {
      chunks.push(current.trim());
      const overlap = current.slice(Math.max(0, current.length - OVERLAP_CHARS));
      current = `${overlap}\n\n${unit}`;
    } else {
      current = current ? `${current}\n\n${unit}` : unit;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.map((content, index) => ({
    content,
    index,
    tokenCount: estimateTokens(content),
  }));
}

// Re-embed a document from scratch: drop existing chunks, chunk, embed in
// batches, insert. Idempotent — safe to call on every document edit.
export async function ingestDocument(documentId: string, rawContent: string): Promise<number> {
  const content = rawContent.trim();
  if (!content) throw new ValidationError('Document content is empty');

  const { error: deleteError } = await supabase
    .from('knowledge_chunks')
    .delete()
    .eq('document_id', documentId);
  if (deleteError) {
    throw new UpstreamError('failed to clear existing chunks', { retryable: true, cause: deleteError });
  }

  const chunks = chunkText(content);
  if (chunks.length === 0) return 0;

  const embeddings = getEmbeddingsProvider();
  const rows: Array<Record<string, unknown>> = [];

  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const vectors = await embeddings.embed(batch.map((c) => c.content));
    batch.forEach((chunk, j) => {
      const vector = vectors[j];
      if (!vector) throw new UpstreamError('embedding missing for chunk', { retryable: false });
      rows.push({
        document_id: documentId,
        chunk_index: chunk.index,
        content: chunk.content,
        embedding: toVectorLiteral(vector),
        token_count: chunk.tokenCount,
      });
    });
  }

  const { error: insertError } = await supabase.from('knowledge_chunks').insert(rows);
  if (insertError) {
    throw new UpstreamError('failed to insert chunks', { retryable: true, cause: insertError });
  }

  logger.info({ documentId, chunks: rows.length }, 'ingested knowledge document');
  return rows.length;
}

export interface DocumentResult {
  id: string;
  title: string;
  chunkCount: number;
}

export async function createDocument(args: {
  title: string;
  content: string;
  sourceType?: string;
}): Promise<DocumentResult> {
  const { data, error } = await supabase
    .from('knowledge_documents')
    .insert({
      title: args.title,
      raw_content: args.content,
      source_type: args.sourceType ?? 'manual',
    })
    .select('id, title')
    .single();
  if (error) throw new UpstreamError('failed to create document', { retryable: true, cause: error });

  const doc = data as { id: string; title: string };
  const chunkCount = await ingestDocument(doc.id, args.content);
  return { id: doc.id, title: doc.title, chunkCount };
}

export async function updateDocument(
  id: string,
  args: { title?: string; content?: string },
): Promise<DocumentResult> {
  const patch: Record<string, unknown> = {};
  if (args.title !== undefined) patch.title = args.title;
  if (args.content !== undefined) patch.raw_content = args.content;
  if (Object.keys(patch).length === 0) throw new ValidationError('No fields to update');

  const { data, error } = await supabase
    .from('knowledge_documents')
    .update(patch)
    .eq('id', id)
    .select('id, title, raw_content')
    .single();
  if (error) throw new UpstreamError('failed to update document', { retryable: true, cause: error });

  const doc = data as { id: string; title: string; raw_content: string };
  // Re-embed only when content changed; a title-only edit leaves chunks intact.
  const chunkCount =
    args.content !== undefined
      ? await ingestDocument(doc.id, doc.raw_content)
      : await countChunks(doc.id);
  return { id: doc.id, title: doc.title, chunkCount };
}

async function countChunks(documentId: string): Promise<number> {
  const { count, error } = await supabase
    .from('knowledge_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('document_id', documentId);
  if (error) throw new UpstreamError('failed to count chunks', { retryable: true, cause: error });
  return count ?? 0;
}

export async function deleteDocument(id: string): Promise<void> {
  // chunks are removed via ON DELETE CASCADE.
  const { error } = await supabase.from('knowledge_documents').delete().eq('id', id);
  if (error) throw new UpstreamError('failed to delete document', { retryable: true, cause: error });
}
