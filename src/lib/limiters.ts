import { env } from '../config/env';
import { createLimiter } from './queue';

// Caps concurrent LLM generations so a burst of inbound DMs cannot trigger a
// provider rate-limit storm. Shared by every call site that hits the model.
export const llmLimiter = createLimiter(env.LLM_CONCURRENCY);
