#!/usr/bin/env node
/**
 * CLI test harness for receipt parsing.
 *
 * Usage:
 *   node scripts/test-parse.js path/to/receipt.pdf [vendor_key]
 *
 * vendor_key defaults to "wfm". Exits with code 1 if any page fails to parse.
 */

import { extractTextPages } from '../src/lib/ocr.js';
import { parsers } from '../src/parsers/index.js';

const [, , filePath, vendorKey = 'wfm'] = process.argv;

if (!filePath) {
  console.error('Usage: node scripts/test-parse.js <receipt.pdf> [vendor_key]');
  process.exit(1);
}

const parser = parsers[vendorKey];
if (!parser) {
  console.error(`Unknown vendor key "${vendorKey}". Available: ${Object.keys(parsers).join(', ')}`);
  process.exit(1);
}

let anyFailed = false;

try {
  const pages = await extractTextPages(filePath);

  for (let i = 0; i < pages.length; i++) {
    const pageText = pages[i];
    console.error(`\n--- Page ${i + 1} raw text ---`);
    console.error(pageText.slice(0, 300));

    const parsed = parser.parse(pageText);
    if (parsed === null) {
      console.error(`[page ${i + 1}] parse returned null — not a ${vendorKey} receipt`);
      anyFailed = true;
    } else {
      console.log(JSON.stringify({ page: i + 1, result: parsed }, null, 2));
    }
  }
} catch (err) {
  console.error('Fatal:', err.message);
  process.exit(1);
}

if (anyFailed) process.exit(1);
