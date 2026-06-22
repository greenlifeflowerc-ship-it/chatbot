import type { BotSettings } from '../../types';

export interface EscalationInput {
  settings: BotSettings;
  topSimilarity: number;
  canAnswer: boolean;
  userText: string;
}

export interface EscalationDecision {
  escalate: boolean;
  reason: string | null;
}

function matchedKeyword(text: string, keywords: string[]): string | null {
  const haystack = text.toLowerCase();
  for (const keyword of keywords) {
    const kw = keyword.trim().toLowerCase();
    if (!kw) continue;
    // Word-boundary match so "human" doesn't fire on "humanity".
    const pattern = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (pattern.test(haystack)) return keyword;
  }
  return null;
}

// Decide whether the bot should hand off to a human. Checked in priority order:
// an explicit request to talk to a person wins over everything, then the model
// signalling it cannot answer, then weak retrieval confidence.
export function decideEscalation(input: EscalationInput): EscalationDecision {
  const keyword = matchedKeyword(input.userText, input.settings.escalation_keywords);
  if (keyword) return { escalate: true, reason: `keyword:${keyword}` };

  if (!input.canAnswer) return { escalate: true, reason: 'model_deferred' };

  if (input.topSimilarity < input.settings.confidence_threshold) {
    return { escalate: true, reason: 'low_confidence' };
  }

  return { escalate: false, reason: null };
}

export const BRIDGING_MESSAGE = 'Thanks for your patience — let me connect you with someone who can help.';
