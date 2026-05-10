import { readFile } from 'fs/promises';
import { execSync } from 'child_process';
import path from 'path';
import { createRequire } from 'module';

// pdf-parse ships as CJS; use createRequire to import it from ESM context.
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

// Tesseract is intentionally not a hard dependency — all supported inputs are
// scan-app PDFs with embedded text layers. HEIC support is a future concern.
try {
  execSync('which tesseract', { stdio: 'ignore' });
} catch {
  // tesseract absent — silently continue; image-only PDFs will warn per-page
}

/**
 * Extract text from each page of a PDF, returning one string per page.
 * Empty/whitespace pages produce a warning sentinel string rather than aborting.
 *
 * @param {string} filePath  Absolute path to a PDF file.
 * @returns {Promise<string[]>}  One element per page.
 */
export async function extractTextPages(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.heic' || ext === '.heif') {
    throw new Error(
      'HEIC input not yet supported — convert to PDF and re-import.'
    );
  }

  const buf = await readFile(filePath);
  const pageTexts = [];

  // The pagerender callback is invoked once per page by pdf-parse.
  // It MUST return a string (or Promise<string>); pdf-parse collects these.
  // The returned strings are NOT exposed on the result object — we capture
  // them via closure into pageTexts instead.
  const options = {
    pagerender(pageData) {
      return pageData.getTextContent().then((tc) => {
        const text = tc.items
          .map((item) => item.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        pageTexts.push(text);
        // Must return a string — pdf-parse uses this as the page's text.
        return text;
      });
    },
  };

  await pdfParse(buf, options);

  // If pagerender was never called (e.g. empty or image-only PDF),
  // fall back to the concatenated text result from a second pass.
  if (pageTexts.length === 0) {
    const fallback = await pdfParse(buf);
    const text = (fallback.text ?? '').trim();
    return [
      text.length > 0
        ? text
        : '[WARNING: page 1 yielded no text]',
    ];
  }

  return pageTexts.map((text, idx) => {
    if (!text) {
      return `[WARNING: page ${idx + 1} yielded no text]`;
    }
    return text;
  });
}
