/**
 * Voice text transformer utility.
 * Uses Claude (Haiku) to transform assistant messages into voice-friendly format.
 * Optimizes text for speech synthesis by removing URLs, code blocks, charts, etc.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDefaultOptions } from '../agent/options.ts';

// Use Haiku for fast, cost-effective transformations
const VOICE_TRANSFORM_MODEL = 'claude-haiku-4-20250213';

/**
 * Transform assistant message text for voice/speech synthesis.
 *
 * Transformations:
 * - Removes or describes URLs naturally
 * - Summarizes code blocks instead of reading syntax
 * - Describes ASCII diagrams/charts instead of reading characters
 * - Uses natural, conversational phrasing
 * - Shortens verbose explanations
 *
 * @param text - The original assistant message text
 * @returns Voice-optimized text, or null if transformation fails
 */
export async function transformForVoice(text: string): Promise<string | null> {
  try {
    const prompt = [
      'Transform this assistant message for voice/speech synthesis. The user will hear this read aloud, so optimize for listening.',
      '',
      'Rules:',
      '- Skip URLs entirely, or say "there\'s a link" if context requires it',
      '- For code blocks: briefly describe what the code does (e.g., "Here\'s a function that calculates the total") instead of reading syntax',
      '- For ASCII diagrams, charts, or tables: describe what they show in natural language',
      '- Use contractions and conversational tone (e.g., "it\'s" not "it is")',
      '- Simplify complex technical terms when possible',
      '- Keep the same meaning and information, just optimized for listening',
      '- If the message is already voice-friendly, return it mostly unchanged',
      '- Do NOT add greetings, sign-offs, or meta-commentary',
      '',
      'Reply with ONLY the transformed text — nothing else.',
      '',
      'Original message:',
      text,
      '',
      'Voice-optimized version:',
    ].join('\n');

    const defaultOptions = getDefaultOptions();
    const options = {
      ...defaultOptions,
      model: VOICE_TRANSFORM_MODEL,
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
    if (trimmed && trimmed.length > 0 && trimmed.length < 50000) {
      return trimmed;
    }

    return null;
  } catch (error) {
    console.error('[voice-transformer] Failed to transform text:', error);
    return null;
  }
}
