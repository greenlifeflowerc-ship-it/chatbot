import type { BotSettings, ChunkMatch, Message } from '../../types';
import { getLlmProvider, type LlmMessage } from '../llm/provider';

export interface GenerationResult {
  answer: string;
  canAnswer: boolean;
  raw: string;
}

const BASE_RULES = `Rules:
- You are a real, friendly member of the business's team — warm, natural, and human. Never sound robotic, formal, or scripted.
- Write the way a helpful person texts on Instagram: short, casual, and clear. One or two sentences is usually enough. A light emoji is fine when it fits.
- Continue the conversation naturally, using the earlier messages for context.
- Reply in the SAME language the customer used (match Arabic with Arabic, English with English, the same dialect when you can).
- Use the business profile and knowledge base. When asked, give the location, phone, or website link; share the link in your first reply.
- Don't invent prices, times, or policies that aren't provided — if you're unsure, say you'll check or offer to connect them with the team.
- Reply with ONLY the message text to send — no quotes, no JSON, no labels, no preamble.`;

function buildBusinessProfile(settings: BotSettings): string[] {
  const p = settings.business_profile ?? {};
  const lines: string[] = [
    `You are the customer-service assistant${p.businessName ? ` for ${p.businessName}` : ''}, replying inside Instagram direct messages.`,
  ];
  if (p.about?.trim()) lines.push(`About the business: ${p.about.trim()}`);
  if (p.products?.trim()) lines.push(`Products and services: ${p.products.trim()}`);
  if (p.hours?.trim()) lines.push(`Hours: ${p.hours.trim()}`);
  if (p.contact?.trim()) lines.push(`Contact: ${p.contact.trim()}`);
  if (p.website?.trim()) lines.push(`Website / booking link: ${p.website.trim()}`);
  if (p.location?.trim()) lines.push(`Location: ${p.location.trim()}`);
  if (p.phone?.trim()) lines.push(`Phone number: ${p.phone.trim()}`);
  if (p.tone?.trim()) lines.push(`Reply in a ${p.tone.trim()} tone.`);
  if (p.guidelines?.trim()) lines.push(`Guidelines: ${p.guidelines.trim()}`);
  if (settings.system_prompt.trim()) lines.push(settings.system_prompt.trim());
  return lines;
}

function buildSystemPrompt(settings: BotSettings, chunks: ChunkMatch[], isFirstReply: boolean): string {
  const context =
    chunks.length > 0
      ? chunks.map((c, i) => `[${i + 1}] ${c.content}`).join('\n\n')
      : '(no knowledge base entries)';

  const website = settings.business_profile?.website?.trim();
  const firstReplyNote =
    isFirstReply && website
      ? `This is your first reply to this customer — greet them and include the website link (${website}).`
      : null;

  return [
    ...buildBusinessProfile(settings),
    BASE_RULES,
    firstReplyNote,
    '--- KNOWLEDGE BASE CONTEXT ---',
    context,
    '--- END CONTEXT ---',
  ]
    .filter(Boolean)
    .join('\n\n');
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
  isFirstReply?: boolean;
}): Promise<GenerationResult> {
  const llm = getLlmProvider();
  const system = buildSystemPrompt(args.settings, args.chunks, args.isFirstReply ?? false);
  const messages = toConversationMessages(args.history);

  // Shorter, warmer replies — also faster to generate (less to stream back).
  const raw = await llm.complete({ system, messages, maxTokens: 350, temperature: 0.55 });
  const answer = raw.trim();
  return { answer, canAnswer: answer.length > 0, raw };
}
