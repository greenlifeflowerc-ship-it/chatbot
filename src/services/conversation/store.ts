import { UpstreamError } from '../../lib/errors';
import { supabase } from '../../lib/supabase';
import type {
  BotSettings,
  Conversation,
  ConversationStatus,
  Customer,
  Message,
  MessageSender,
  MessageStatus,
} from '../../types';
import type { IgProfile } from '../instagram/client';

function nowIso(): string {
  return new Date().toISOString();
}

// Translate a Supabase error into a retryable upstream error so callers can rely
// on a single throw type.
function fail(message: string, cause: unknown): never {
  throw new UpstreamError(message, { retryable: true, cause });
}

export async function getBotSettings(): Promise<BotSettings> {
  const { data, error } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
  if (error) fail('failed to load bot settings', error);
  const row = data as BotSettings;
  // Default business_profile so the bot works before the migration is applied.
  return { ...row, business_profile: row.business_profile ?? {} };
}

// Insert the customer on first contact, otherwise just refresh last_seen_at.
// The profile resolver is invoked lazily and only for brand-new customers, so a
// returning customer never costs a Graph API profile lookup.
export async function upsertCustomer(
  igUserId: string,
  resolveProfile?: () => Promise<IgProfile | null>,
): Promise<Customer> {
  const { data: existing, error: selectError } = await supabase
    .from('customers')
    .select('*')
    .eq('ig_user_id', igUserId)
    .maybeSingle();
  if (selectError) fail('failed to look up customer', selectError);

  if (existing) {
    const row = existing as Customer;
    const { data, error } = await supabase
      .from('customers')
      .update({ last_seen_at: nowIso() })
      .eq('id', row.id)
      .select('*')
      .single();
    if (error) fail('failed to update customer', error);
    return data as Customer;
  }

  const profile = resolveProfile ? await resolveProfile() : null;
  const { data, error } = await supabase
    .from('customers')
    .insert({
      ig_user_id: igUserId,
      username: profile?.username ?? null,
      full_name: profile?.name ?? null,
      profile_pic: profile?.profilePic ?? null,
    })
    .select('*')
    .single();
  if (error) fail('failed to create customer', error);
  return data as Customer;
}

export async function getOrCreateConversation(
  customerId: string,
): Promise<{ conversation: Conversation; isNew: boolean }> {
  const { data: open, error: selectError } = await supabase
    .from('conversations')
    .select('*')
    .eq('customer_id', customerId)
    .neq('status', 'closed')
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (selectError) fail('failed to look up conversation', selectError);

  if (open) return { conversation: open as Conversation, isNew: false };

  const { data, error } = await supabase
    .from('conversations')
    .insert({ customer_id: customerId, status: 'bot' })
    .select('*')
    .single();
  if (error) fail('failed to create conversation', error);
  return { conversation: data as Conversation, isNew: true };
}

export async function getConversation(conversationId: string): Promise<Conversation | null> {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .maybeSingle();
  if (error) fail('failed to load conversation', error);
  return (data as Conversation) ?? null;
}

export async function recordInboundMessage(args: {
  conversationId: string;
  content: string;
  igMessageId: string;
}): Promise<Message> {
  const ts = nowIso();
  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: args.conversationId,
      sender: 'customer' satisfies MessageSender,
      content: args.content,
      ig_message_id: args.igMessageId,
      status: 'received' satisfies MessageStatus,
    })
    .select('*')
    .single();
  if (error) fail('failed to record inbound message', error);

  const { error: convError } = await supabase
    .from('conversations')
    .update({ last_customer_at: ts, last_message_at: ts })
    .eq('id', args.conversationId);
  if (convError) fail('failed to bump conversation timestamps', convError);

  return data as Message;
}

export async function recordOutboundMessage(args: {
  conversationId: string;
  sender: Extract<MessageSender, 'bot' | 'agent' | 'system'>;
  content: string;
  status: MessageStatus;
  error?: string;
  igMessageId?: string;
  metadata?: Record<string, unknown>;
}): Promise<Message> {
  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: args.conversationId,
      sender: args.sender,
      content: args.content,
      status: args.status,
      error: args.error ?? null,
      ig_message_id: args.igMessageId ?? null,
      metadata: args.metadata ?? {},
    })
    .select('*')
    .single();
  if (error) fail('failed to record outbound message', error);

  const { error: convError } = await supabase
    .from('conversations')
    .update({ last_message_at: nowIso() })
    .eq('id', args.conversationId);
  if (convError) fail('failed to bump conversation timestamp', convError);

  return data as Message;
}

// Recent turns for LLM context, oldest-first. System notices are excluded — only
// the actual dialogue (customer/bot/agent) is relevant to generation.
export async function getRecentHistory(conversationId: string, limit: number): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .in('sender', ['customer', 'bot', 'agent'])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail('failed to load conversation history', error);
  return ((data as Message[]) ?? []).reverse();
}

// Move a conversation to a new status and record the handover in one logical
// step. Reads the prior status first so the handover row captures from_status.
export async function transitionStatus(args: {
  conversationId: string;
  to: ConversationStatus;
  reason?: string;
  agentId?: string | null;
  assign?: boolean;
}): Promise<Conversation> {
  const current = await getConversation(args.conversationId);
  const fromStatus = current?.status ?? null;

  const patch: Record<string, unknown> = { status: args.to };
  if (args.assign) patch.assigned_agent_id = args.agentId ?? null;

  const { data, error } = await supabase
    .from('conversations')
    .update(patch)
    .eq('id', args.conversationId)
    .select('*')
    .single();
  if (error) fail('failed to update conversation status', error);

  const { error: handoverError } = await supabase.from('handovers').insert({
    conversation_id: args.conversationId,
    from_status: fromStatus,
    to_status: args.to,
    reason: args.reason ?? null,
    agent_id: args.agentId ?? null,
  });
  if (handoverError) fail('failed to record handover', handoverError);

  return data as Conversation;
}
