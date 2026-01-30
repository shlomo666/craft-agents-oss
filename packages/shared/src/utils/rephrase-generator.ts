/**
 * User message rephrase utility.
 * Uses Claude Agent SDK query() to rewrite a user message with better clarity and context.
 * Follows the same pattern as title-generator.ts.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDefaultOptions } from '../agent/options.ts';
import { DEFAULT_MODEL } from '../config/models.ts';
import { resolveModelId } from '../config/storage.ts';

/**
 * Rephrase a user message using AI, preserving intent while improving clarity.
 * Uses full conversation context to add relevant details and make the message
 * more specific and actionable.
 *
 * @param targetMessage - The user message to rephrase
 * @param conversationContext - Preceding messages for context (alternating user/assistant)
 * @returns Rephrased message text, or null if generation fails
 */
export async function rephraseUserMessage(
  targetMessage: string,
  conversationContext: Array<{ role: 'user' | 'assistant'; content: string }>,
  availableMentions?: string[]
): Promise<string | null> {
  try {
    // Build conversation context (truncate each message to keep prompt manageable)
    const contextLines = conversationContext
      .slice(-10)  // Last 10 messages max
      .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content.slice(0, 500)}`)
      .join('\n\n');

    // Build mention tagging instructions
    const mentionInstructions = availableMentions?.length
      ? [
          '',
          'IMPORTANT: The user has these data sources and skills available as @mentions:',
          availableMentions.join(', '),
          'If the user\'s message references something that clearly matches one of these @mentions, INCLUDE the @mention in your rephrased text.',
          'For example: "help me with the gateway" → "Explain how @third-party-gw-api works" (if that source exists).',
          'Only tag mentions that are clearly relevant — do not force-tag unrelated sources.',
        ]
      : [];

    const prompt = [
      'You are a writing assistant. Rephrase the user\'s message to be clearer, more specific, and more actionable.',
      'Preserve the original intent completely. Add relevant context from the conversation if it helps clarify the request.',
      'Do NOT add pleasantries, greetings, or filler. Do NOT explain what you changed.',
      'Reply with ONLY the rephrased message text — nothing else.',
      ...mentionInstructions,
      '',
      ...(contextLines ? ['Conversation context:', contextLines, ''] : []),
      'Original message to rephrase:',
      targetMessage,
      '',
      'Rephrased message:',
    ].join('\n');

    const defaultOptions = getDefaultOptions();
    const options = {
      ...defaultOptions,
      model: resolveModelId(DEFAULT_MODEL),
      maxTurns: 1,
    };

    let result = '';

    for await (const message of query({ prompt, options })) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            result += block.text;
          }
        }
      }
    }

    const trimmed = result.trim();

    // Validate: non-empty and reasonable length
    if (trimmed && trimmed.length > 0 && trimmed.length < 10000) {
      return trimmed;
    }

    return null;
  } catch (error) {
    console.error('[rephrase-generator] Failed to rephrase message:', error);
    return null;
  }
}
