import { readFile } from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';

// pdf-parse v2 ships as CJS with a class-based API; use createRequire from ESM.
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

// Tesseract is intentionally not a dependency — all supported inputs are
// scan-app PDFs with embedded text layers.
// HEIC support is a future concern (requires OCR sidecar container).

/**
 * Extract text from each page of a PDF, returning one string per page.
 * Uses pdf-parse v2's getText() which returns { pages: [{ text, num }] }.
 * Empty/whitespace pages produce a warning sentinel string rather than aborting.
 *
 * @param {string} filePath  Absolute path to a PDF file.
 * @returns {Promise<string[]>}  One element per page, in page order.
 */
export async function extractTextPages(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.heic' || ext === '.heif') {
    throw new Error(
      'HEIC input not yet supported — convert to PDF and re-import.'
    );
  }

  const data = await readFile(filePath);

  // pdf-parse v2: constructor takes { data: Buffer, ...options }
  // getText() resolves to { pages: Array<{ text: string, num: number }>, text: string, total: number }
  const parser = new PDFParse({ data });
  const result = await parser.getText();

  if (!result.pages || result.pages.length === 0) {
    // Fallback: single-page result with no page array
    const text = (result.text ?? '').trim();
    return [text.length > 0 ? text : '[WARNING: page 1 yielded no text]'];
  }

  // Pages come back sorted by num; map to strings in order.
  return result.pages.map((page, idx) => {
    const text = (page.text ?? '').trim();
    if (!text) {
      return `[WARNING: page ${page.num ?? idx + 1} yielded no text]`;
    }
    return text;
  });
}
