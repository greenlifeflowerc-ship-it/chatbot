import type { FastifyRequest } from 'fastify';
import { UnauthorizedError } from './errors';
import { supabase } from './supabase';

export interface AuthedAgent {
  agentId: string;
  email: string;
}

// Verify a Supabase access token server-side. We let Supabase validate the JWT
// (signature, expiry, revocation) via getUser rather than trusting it locally,
// then map the user to an agent identity.
export async function authenticate(request: FastifyRequest): Promise<AuthedAgent> {
  const header = request.headers['authorization'];
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) throw new UnauthorizedError('Missing bearer token');

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new UnauthorizedError('Invalid or expired token');

  return { agentId: data.user.id, email: data.user.email ?? '' };
}
