import { describe, expect, it } from 'vitest';
import { decideEscalation } from '../src/services/handover/escalate';
import type { BotSettings } from '../src/types';

const settings: BotSettings = {
  id: 1,
  disclosure_message: '',
  system_prompt: '',
  confidence_threshold: 0.7,
  escalation_keywords: ['human', 'agent', 'complaint'],
  greeting_enabled: true,
  business_profile: {},
  updated_at: '2026-01-01T00:00:00Z',
};

describe('decideEscalation', () => {
  it('escalates on an explicit keyword', () => {
    const d = decideEscalation({ settings, topSimilarity: 0.95, canAnswer: true, userText: 'Can I talk to a human?' });
    expect(d).toEqual({ escalate: true, reason: 'keyword:human' });
  });

  it('respects word boundaries (does not fire on "humanity")', () => {
    const d = decideEscalation({ settings, topSimilarity: 0.95, canAnswer: true, userText: 'humanity is great' });
    expect(d.escalate).toBe(false);
  });

  it('escalates when the model cannot answer', () => {
    const d = decideEscalation({ settings, topSimilarity: 0.95, canAnswer: false, userText: 'obscure question' });
    expect(d).toEqual({ escalate: true, reason: 'model_deferred' });
  });

  it('escalates on low retrieval confidence', () => {
    const d = decideEscalation({ settings, topSimilarity: 0.4, canAnswer: true, userText: 'something niche' });
    expect(d).toEqual({ escalate: true, reason: 'low_confidence' });
  });

  it('answers when confident with no keyword', () => {
    const d = decideEscalation({ settings, topSimilarity: 0.88, canAnswer: true, userText: 'what are your hours' });
    expect(d).toEqual({ escalate: false, reason: null });
  });
});
