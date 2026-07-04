'use strict';
/**
 * Claude on the Anthropic API — writes shopper search tags for a product.
 * Switched on by setting ANTHROPIC_API_KEY in the environment; without it
 * enabled() is false, /api/config reports aiTagsEnabled:false, and the
 * seller dashboard hides the button.
 */
const { normalizeTags } = require('./tags');

const MODEL = 'claude-opus-4-8';

let _client = null;
function client() {
  if (!_client) {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

const enabled = () => !!process.env.ANTHROPIC_API_KEY;

// Structured output: the response is guaranteed to be this JSON shape.
const TAG_SCHEMA = {
  type: 'object',
  properties: { tags: { type: 'array', items: { type: 'string' } } },
  required: ['tags'],
  additionalProperties: false,
};

async function suggestTags({ name, description = '', category = '', shopName = '' }) {
  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 500,
    output_config: { format: { type: 'json_schema', schema: TAG_SCHEMA } },
    messages: [{
      role: 'user',
      content: `You write search tags for Trove, a curated marketplace of handmade goods in Dubai and Abu Dhabi. Shoppers type these into the search box, so each tag must be a short phrase someone would actually search for: the material, the technique, the style, the room or use, the occasion or gift angle, and close synonyms of the product's name. Lowercase, one to three words each, no hashtags. Don't repeat the product name or category word-for-word. Return 8 to 12 tags.

Product: ${name}
Category: ${category}
Shop: ${shopName}
Description: ${description}`,
    }],
  });
  if (response.stop_reason === 'refusal') return [];
  const text = (response.content.find((b) => b.type === 'text') || {}).text || '{}';
  return normalizeTags(JSON.parse(text).tags);
}

module.exports = { enabled, suggestTags, MODEL };
