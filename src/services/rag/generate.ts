import type { BotSettings, ChunkMatch, Message } from '../../types';
import { getLlmProvider, type LlmMessage } from '../llm/provider';

export interface GenerationResult {
  answer: string;
  canAnswer: boolean;
  raw: string;
}

const BASE_RULES = `Rules:
- You represent the business. Use the business profile and the knowledge base to help the customer.
- Be helpful and conversational. Continue the conversation naturally across multiple messages, using the earlier messages for context.
- Follow the business profile and guidelines exactly — tone, products, hours, and policies.
- Do not invent specific facts (prices, exact times, policies) that are not provided. If you don't know a specific detail, say you'll check or offer to connect them with the team.
- Keep replies short and friendly, suitable for an Instagram DM.
- Reply with ONLY the message text to send the customer — no quotes, no JSON, no labels, no preamble.`;

function buildBusinessProfile(settings: BotSettings): string[] {
  const p = settings.business_profile ?? {};
  const lines: string[] = [
    `You are the customer-service assistant${p.businessName ? ` for ${p.businessName}` : ''}, replying inside Instagram direct messages.`,
  ];
  if (p.about?.trim()) lines.push(`About the business: ${p.about.trim()}`);
  if (p.products?.trim()) lines.push(`Products and services: ${p.products.trim()}`);
  if (p.hours?.trim()) lines.push(`Hours: ${p.hours.trim()}`);
  if (p.contact?.trim()) lines.push(`Contact: ${p.contact.trim()}`);
  if (p.tone?.trim()) lines.push(`Reply in a ${p.tone.trim()} tone.`);
  if (p.guidelines?.trim()) lines.push(`Guidelines: ${p.guidelines.trim()}`);
  if (settings.system_prompt.trim()) lines.push(settings.system_prompt.trim());
  return lines;
}

function buildSystemPrompt(settings: BotSettings, chunks: ChunkMatch[]): string {
  const context =
    chunks.length > 0
      ? chunks.map((c, i) => `[${i + 1}] ${c.content}`).join('\n\n')
      : '(no knowledge base entries)';

  return [
    ...buildBusinessProfile(settings),
    BASE_RULES,
    '--- KNOWLEDGE BASE CONTEXT ---',
    context,
    '--- END CONTEXT ---',
  ].join('\n\n');
}

function senderToRole(sender: Message['sender']): LlmMessage['role'] {
  return sender === 'customer' ? 'user' : 'assistant';
}

// Map stored history to provider messages, then enforce the constraints the API
// expects: start on a user turn and merge consecutive same-role turns.
function toConversationMessages(history: Message[]): LlmMessage[] {
  const mapped: LlmMessage[] = history.map((m) => ({
    role: senderToRole(m.sender),
    content: m.content,
  }));

  while (mapped.length > 0 && mapped[0]!.role !== 'user') mapped.shift();

  const merged: LlmMessage[] = [];
  for (const msg of mapped) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) last.content = `${last.content}\n\n${msg.content}`;
    else merged.push({ ...msg });
  }
  return merged;
}

// Generate a plain-text reply that follows the business profile and continues the
// conversation. `history` is chronological and already includes the current
// customer message as its final turn. An empty reply marks canAnswer=false so the
// worker hands off rather than sending nothing.
export async function generateAnswer(args: {
  settings: BotSettings;
  chunks: ChunkMatch[];
  history: Message[];
}): Promise<GenerationResult> {
  const llm = getLlmProvider();
  const system = buildSystemPrompt(args.settings, args.chunks);
  const messages = toConversationMessages(args.history);

  const raw = await llm.complete({ system, messages, maxTokens: 700, temperature: 0.4 });
  const answer = raw.trim();
  return { answer, canAnswer: answer.length > 0, raw };
}
