import { describe, expect, it } from 'vitest';
import { toVectorLiteral } from '../src/lib/vector';

describe('toVectorLiteral', () => {
  it('formats a bracketed pgvector literal', () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
  });

  it('handles an empty vector', () => {
    expect(toVectorLiteral([])).toBe('[]');
  });
});
