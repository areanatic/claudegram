import assert from 'node:assert/strict';
import {
  escapeTelegramMarkdown,
  replyWithMarkdownFallback,
} from './markdown.js';

type Sent = { text: string; options: { parse_mode?: string } };

const dynamicBriefValues = [
  'mail_search',
  'workspace-google-rw',
  'nexus-mail',
  'tool*with`bracket[and)paren]',
];

const escapedBriefValues = dynamicBriefValues.map(escapeTelegramMarkdown);
assert.deepEqual(escapedBriefValues, [
  'mail\\_search',
  'workspace-google-rw',
  'nexus-mail',
  'tool\\*with\\`bracket\\[and\\)paren\\]',
]);

// /brief regression: a capability list containing Telegram Markdown characters
// remains a single well-formed Markdown message.
const briefText = `*Tatsächlich verbundene Fähigkeiten:*\n- ${escapedBriefValues.join(', ')}`;
assert.equal(briefText.includes('mail\\_search'), true);
assert.equal(briefText.includes('tool\\*with\\`bracket\\[and\\)paren\\]'), true);

const sent: Sent[] = [];
let attempts = 0;
const parseFailingContext = {
  reply: async (text: string, options: { parse_mode?: string }) => {
    sent.push({ text, options });
    attempts += 1;
    if (attempts === 1) {
      throw new Error("GrammyError: Call to 'sendMessage' failed (400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 192)");
    }
    return { message_id: attempts };
  },
};

await replyWithMarkdownFallback(parseFailingContext as never, briefText, { parse_mode: 'Markdown' });
assert.equal(sent.length, 2);
assert.equal(sent[0].options.parse_mode, 'Markdown');
assert.equal(sent[1].options.parse_mode, undefined);
assert.equal(sent[1].text, briefText);

const nonParseFailingContext = {
  reply: async () => {
    throw new Error('GrammyError: Call to sendMessage failed (403: Forbidden)');
  },
};
await assert.rejects(
  () => replyWithMarkdownFallback(nonParseFailingContext as never, 'hello', { parse_mode: 'MarkdownV2' }),
  /403: Forbidden/,
);

console.log('✅ markdown-fallback: escaped /brief capability values and verified parse-error plaintext retry');
