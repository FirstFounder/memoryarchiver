import { readFile } from 'fs/promises';
import { execSync } from 'child_process';
import path from 'path';
import { PDFParse } from 'pdf-parse';

// Warn at startup if tesseract is unavailable; it is never a hard dependency.
let _tesseractAvailable = false;
try {
  execSync('which tesseract', { stdio: 'ignore' });
  _tesseractAvailable = true;
} catch {
  console.warn('[ocr] tesseract not found — OCR image fallback disabled');
}

/**
 * Extract text from each page of a PDF, returning one string per page.
 * Empty/whitespace pages produce a warning sentinel string instead of aborting.
 *
 * @param {string} filePath
 * @returns {Promise<string[]>}
 */
export async function extractTextPages(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.heic' || ext === '.heif') {
    throw new Error('HEIC input not yet supported.');
  }

  const data = await readFile(filePath);
  const parser = new PDFParse({ data });
  const result = await parser.getText();
  await parser.destroy();

  const pages = result.pages;
  if (!pages || pages.length === 0) {
    // Single-page PDFs with no selectable text surface as empty result.
    return ['[WARNING: page 1 yielded no text]'];
  }

  return pages.map((page, idx) => {
    const text = page.text ?? '';
    if (!text.trim()) {
      return `[WARNING: page ${idx + 1} yielded no text]`;
    }
    return text;
  });
}
