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
      'Convert this text to a voice-friendly summary. Someone will HEAR this, not read it.',
      '',
      'CRITICAL RULES:',
      '- TABLES: NEVER read tables row by row. Summarize: "I made changes to 9 files across the codebase, adding voice transformation support."',
      '- FILE PATHS: NEVER read paths like "packages/ui/src/...". Say "the UI package" or "several files".',
      '- CODE: NEVER read code syntax. Say "I added a function that transforms text for speech".',
      '- DIAGRAMS: NEVER read ASCII art. Describe the flow: "The process starts with X, then Y, and finally Z."',
      '- URLS: Skip entirely or say "there\'s a link to the docs".',
      '',
      'STYLE:',
      '- Be BRIEF. Aim for 20-30% of original length for technical content.',
      '- Use contractions (it\'s, we\'ve, that\'s).',
      '- Focus on insights and takeaways, not details.',
      '- Speak like you\'re explaining to a colleague, not writing documentation.',
      '',
      'DO NOT add "Here\'s the summary" or any meta-commentary. Just give the transformed text.',
      '',
      'Original:',
      text,
      '',
      'Voice version:',
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
