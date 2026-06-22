// pgvector expects its text input form: a bracketed, comma-separated list
// (e.g. "[0.1,0.2,0.3]"). Passing a raw JS array through PostgREST is ambiguous,
// so we always serialise to this literal for both inserts and RPC arguments.
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
