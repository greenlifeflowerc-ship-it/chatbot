import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/services/rag/ingest';

describe('chunkText', () => {
  it('splits on paragraphs and indexes sequentially', () => {
    const text = ['First paragraph.', 'Second paragraph.', 'Third paragraph.'].join('\n\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(0);
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.content.length).toBeGreaterThan(0);
      expect(c.tokenCount).toBeGreaterThan(0);
    });
  });

  it('hard-splits a paragraph larger than the target', () => {
    const huge = 'x'.repeat(5000);
    const chunks = chunkText(huge);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('returns nothing for whitespace-only input', () => {
    expect(chunkText('   \n\n  ')).toHaveLength(0);
  });
});
