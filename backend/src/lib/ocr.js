import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';

// pdf-parse v2 ships as CJS; use createRequire from ESM context.
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

// Tesseract is intentionally not a hard dependency.
// All supported inputs are preprocessed via the ocr-receipts.sh script on squat,
// which produces .pNN.txt sidecar files alongside each PDF.
// HEIC support is a future concern (requires OCR sidecar container).

/**
 * Extract text from each page of a PDF, returning one string per page.
 *
 * Primary path: read pre-existing .pNN.txt sidecar files produced by ocr-receipts.sh.
 * Fallback: attempt pdf-parse text extraction (works only for text-layer PDFs).
 * If both fail, returns warning sentinel strings rather than throwing.
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

  // --- Primary path: read sidecar .txt files ---
  const sidecarPages = await readSidecars(filePath);
  if (sidecarPages.length > 0) {
    return sidecarPages;
  }

  // --- Fallback: attempt pdf-parse text extraction ---
  // This works only for text-layer PDFs (not scan-app image PDFs).
  try {
    const data = await readFile(filePath);
    const parser = new PDFParse({ data: new Uint8Array(data) });
    const result = await parser.getText();

    if (result.pages?.length > 0) {
      const pages = result.pages.map((page, idx) => {
        const text = (page.text ?? '').trim();
        return text || `[WARNING: page ${page.num ?? idx + 1} yielded no text — no sidecar found and pdf-parse extracted nothing]`;
      });
      // Only return if at least one page has real content
      if (pages.some(p => !p.startsWith('[WARNING'))) {
        return pages;
      }
    }
  } catch (err) {
    // pdf-parse failure is non-fatal — fall through to error return
  }

  // --- Both paths failed ---
  return [
    `[WARNING: no sidecar .txt files found for ${path.basename(filePath)} and pdf-parse extracted no text. Run ocr-receipts.sh on squat to generate sidecars, then copy them to the inbox directory.]`
  ];
}

/**
 * Look for pre-generated sidecar text files alongside the PDF.
 * For foo.pdf, looks for foo.p01.txt, foo.p02.txt, ... in order.
 * Stops at the first missing page number.
 *
 * @param {string} pdfPath
 * @returns {Promise<string[]>}  Array of page texts, empty if no sidecars found.
 */
async function readSidecars(pdfPath) {
  const base = pdfPath.replace(/\.pdf$/i, '');
  const pages = [];
  let pageNum = 1;

  while (true) {
    const padded = String(pageNum).padStart(2, '0');
    const sidecarPath = `${base}.p${padded}.txt`;

    if (!existsSync(sidecarPath)) {
      break;
    }

    const text = (await readFile(sidecarPath, 'utf8')).trim();
    pages.push(text || `[WARNING: page ${pageNum} sidecar exists but is empty]`);
    pageNum++;
  }

  return pages;
}
