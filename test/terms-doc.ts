// docs/TERMS.md and the Terms the page shows say the same, word for word: each of the page's
// paragraphs, with <strong> written as **, is one item of the document's numbered list.
//   tsx test/terms-doc.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERMS } from '../web/components/markup';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const words = (text: string): string => text.replace(/\s+/g, ' ').trim();

const page = [...TERMS.matchAll(/<p class="lede">([\s\S]*?)<\/p>/g)]
  .map(([, body]) => words(body.replace(/<\/?strong>/g, '**')));
assert.ok(page.length > 0, 'the page shows the Terms as paragraphs');
assert.equal(words(TERMS.replace(/<p class="lede">[\s\S]*?<\/p>/g, '')), '', 'the Terms are paragraphs and nothing else');
assert.ok(page.every((paragraph) => !/[<>]/.test(paragraph)), 'a paragraph holds no markup but <strong>');

const doc = readFileSync(join(ROOT, 'docs', 'TERMS.md'), 'utf8');
const section = /^## The text\n([\s\S]*?)^## /m.exec(doc)?.[1];
assert.ok(section !== undefined, 'docs/TERMS.md has a "The text" section');
const listed = section.split(/^\d+\. /m);
assert.equal(words(listed[0]), '', 'the section is the numbered list alone');

assert.deepEqual(listed.slice(1).map(words), page, 'docs/TERMS.md says what the page says');
console.log(`ok: docs/TERMS.md matches the ${page.length} paragraphs of the page's Terms`);
