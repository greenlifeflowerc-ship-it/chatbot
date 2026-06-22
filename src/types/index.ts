// Domain types mirroring the Supabase schema (see supabase/migrations).
// Kept hand-written and small rather than generated, so the contract is visible
// in one place and shared across the worker, services, and routes.

export type ConversationStatus = 'bot' | 'waiting_human' | 'human' | 'closed';
export type MessageSender = 'customer' | 'bot' | 'agent' | 'system';
export type MessageStatus = 'received' | 'queued' | 'sent' | 'failed';

export interface Customer {
  id: string;
  ig_user_id: string;
  username: string | null;
  full_name: string | null;
  profile_pic: string | null;
  first_seen_at: string;
  last_seen_at: string;
  metadata: Record<string, unknown>;
}

export interface Conversation {
  id: string;
  customer_id: string;
  status: ConversationStatus;
  assigned_agent_id: string | null;
  last_message_at: string;
  last_customer_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender: MessageSender;
  content: string;
  ig_message_id: string | null;
  status: MessageStatus;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  source_type: string;
  raw_content: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeChunk {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
  created_at: string;
}

export interface BotSettings {
  id: number;
  disclosure_message: string;
  system_prompt: string;
  confidence_threshold: number;
  escalation_keywords: string[];
  greeting_enabled: boolean;
  updated_at: string;
}

export interface Handover {
  id: string;
  conversation_id: string;
  from_status: ConversationStatus | null;
  to_status: ConversationStatus;
  reason: string | null;
  agent_id: string | null;
  created_at: string;
}

// Result of the match_chunks() RPC.
export interface ChunkMatch {
  id: string;
  content: string;
  similarity: number;
}

// Normalised inbound Instagram message extracted from a webhook payload.
export interface InboundMessage {
  igMessageId: string;
  senderId: string; // customer IGSID
  recipientId: string; // the business account IGSID
  text: string;
  timestamp: number;
}

// A single Instagram messaging webhook event, after envelope parsing.
export interface WebhookMessageEvent {
  eventKey: string;
  inbound: InboundMessage;
}
