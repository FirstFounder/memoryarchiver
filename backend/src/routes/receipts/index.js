import fs from 'fs';
import path from 'path';
import db from '../../db/client.js';
import config from '../../config.js';
import { extractTextPages } from '../../lib/ocr.js';
import { parse as wfmParse } from '../../parsers/wfm.js';

function countSidecars(pdfPath) {
  const base = pdfPath.replace(/\.pdf$/i, '');
  let count = 0;
  for (let pageNum = 1; ; pageNum++) {
    const padded = String(pageNum).padStart(2, '0');
    if (!fs.existsSync(`${base}.p${padded}.txt`)) break;
    count++;
  }
  return count || 1;
}

function analyzeResult(parsed) {
  const notes = [];
  if (parsed.date == null)         notes.push('missing date');
  if (parsed.store_number == null) notes.push('missing store number');
  if (parsed.subtotal == null)     notes.push('missing subtotal');
  if (parsed.items.length === 0)   notes.push('no items parsed');

  const isOk = parsed.store_number != null
    && parsed.date != null
    && parsed.subtotal != null
    && parsed.items.length > 0;

  return { parseStatus: isOk ? 'ok' : 'partial', parseNotes: notes.join(', ') };
}

async function processOnePdf(pdfPath) {
  const pdfFilename = path.basename(pdfPath);
  const rawPages    = countSidecars(pdfPath);

  let parsed      = null;
  let parseStatus = 'failed';
  let parseNotes  = '';

  try {
    const pages       = await extractTextPages(pdfPath);
    const combinedText = pages.join('\n');
    parsed = wfmParse(combinedText);
  } catch (err) {
    parseNotes = err.message ?? 'parse error';
  }

  if (parsed !== null) {
    ({ parseStatus, parseNotes } = analyzeResult(parsed));
  }

  const storeNumber  = parsed?.store_number  ?? null;
  const storeAddress = parsed?.store_address ?? null;
  const receiptDate  = parsed?.date          ?? null;
  const subtotal     = parsed?.subtotal      ?? null;
  const taxAmount    = parsed?.tax_amount    ?? null;
  const total        = parsed?.total         ?? null;
  const items        = parsed?.items         ?? [];
  const itemCount    = items.length;

  db.transaction(() => {
    db.prepare(`
      INSERT INTO receipts
        (pdf_filename, pdf_path, store_number, store_address, receipt_date,
         subtotal, tax_amount, total, item_count, parse_status, parse_notes, raw_pages)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pdf_filename) DO UPDATE SET
        pdf_path      = excluded.pdf_path,
        store_number  = excluded.store_number,
        store_address = excluded.store_address,
        receipt_date  = excluded.receipt_date,
        subtotal      = excluded.subtotal,
        tax_amount    = excluded.tax_amount,
        total         = excluded.total,
        item_count    = excluded.item_count,
        parse_status  = excluded.parse_status,
        parse_notes   = excluded.parse_notes,
        raw_pages     = excluded.raw_pages,
        imported_at   = datetime('now')
    `).run(
      pdfFilename, pdfPath, storeNumber, storeAddress, receiptDate,
      subtotal, taxAmount, total, itemCount, parseStatus, parseNotes, rawPages
    );

    const { id: receiptId } = db.prepare(
      'SELECT id FROM receipts WHERE pdf_filename = ?'
    ).get(pdfFilename);

    db.prepare('DELETE FROM receipt_items WHERE receipt_id = ?').run(receiptId);

    const insertItem = db.prepare(`
      INSERT INTO receipt_items
        (receipt_id, page_number, description, price, price_code,
         is_weight_item, weight, rate_per_lb, quantity, unit_price, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    items.forEach((item, i) => {
      insertItem.run(
        receiptId, 1, item.description, item.price, item.price_code ?? null,
        item.is_weight_item ? 1 : 0,
        item.weight ?? null, item.rate_per_lb ?? null,
        item.quantity ?? null, item.unit_price ?? null, i
      );
    });
  })();

  return { parseStatus, pdfFilename };
}

function receiptColumns() {
  return `id, pdf_filename, pdf_path, store_number, store_address,
          receipt_date, subtotal, tax_amount, total, item_count,
          parse_status, parse_notes, raw_pages, imported_at`;
}

export default async function receiptsRoutes(fastify) {

  // ── POST /api/receipts/import-all ─────────────────────────────────────────
  fastify.post('/api/receipts/import-all', async (req, reply) => {
    if (!config.receiptsInputDir) {
      return reply.code(503).send({ error: 'RECEIPTS_INPUT_DIR not configured' });
    }

    let files;
    try {
      files = fs.readdirSync(config.receiptsInputDir)
        .filter(f => f.toLowerCase().endsWith('.pdf'))
        .sort();
    } catch (err) {
      return reply.code(500).send({ error: `Cannot read receipts directory: ${err.message}` });
    }

    const summary = { processed: 0, ok: 0, partial: 0, failed: 0, errors: [] };

    for (const filename of files) {
      const pdfPath = path.join(config.receiptsInputDir, filename);
      try {
        const { parseStatus } = await processOnePdf(pdfPath);
        summary.processed++;
        if (parseStatus in summary) summary[parseStatus]++;
        else summary.failed++;
      } catch (err) {
        summary.processed++;
        summary.failed++;
        summary.errors.push({ filename, error: err.message });
      }
    }

    return reply.send(summary);
  });

  // ── GET /api/receipts/flagged ─────────────────────────────────────────────
  fastify.get('/api/receipts/flagged', async (_req, reply) => {
    const rows = db.prepare(`
      SELECT ${receiptColumns()}
      FROM receipts
      WHERE parse_status IN ('flagged', 'failed', 'partial')
      ORDER BY receipt_date DESC, imported_at DESC
    `).all();
    return reply.send({ receipts: rows, total: rows.length, page: 1, limit: rows.length });
  });

  // ── GET /api/receipts ─────────────────────────────────────────────────────
  fastify.get('/api/receipts', async (req, reply) => {
    const page  = Math.max(1, parseInt(req.query.page  ?? '1',  10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit ?? '50', 10) || 50));
    const { store, status, date_from, date_to } = req.query;

    const conditions = [];
    const params     = [];

    if (store)     { conditions.push('store_number = ?');   params.push(parseInt(store, 10)); }
    if (status)    { conditions.push('parse_status = ?');   params.push(status); }
    if (date_from) { conditions.push('receipt_date >= ?');  params.push(date_from); }
    if (date_to)   { conditions.push('receipt_date <= ?');  params.push(date_to); }

    const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total  = db.prepare(`SELECT COUNT(*) AS n FROM receipts ${where}`).get(...params).n;
    const offset = (page - 1) * limit;

    const receipts = db.prepare(`
      SELECT ${receiptColumns()}
      FROM receipts ${where}
      ORDER BY receipt_date DESC, imported_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return reply.send({ receipts, total, page, limit });
  });

  // ── GET /api/receipts/:id ─────────────────────────────────────────────────
  fastify.get('/api/receipts/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return reply.code(404).send({ error: 'Not found' });

    const receipt = db.prepare(`
      SELECT ${receiptColumns()} FROM receipts WHERE id = ?
    `).get(id);
    if (!receipt) return reply.code(404).send({ error: 'Not found' });

    const items = db.prepare(`
      SELECT id, page_number, description, price, price_code,
             is_weight_item, weight, rate_per_lb, quantity, unit_price, sort_order
      FROM receipt_items
      WHERE receipt_id = ?
      ORDER BY page_number, sort_order
    `).all(id);

    return reply.send({ ...receipt, items });
  });

  // ── DELETE /api/receipts/:id ──────────────────────────────────────────────
  fastify.delete('/api/receipts/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return reply.code(404).send({ error: 'Not found' });

    const receipt = db.prepare('SELECT id FROM receipts WHERE id = ?').get(id);
    if (!receipt) return reply.code(404).send({ error: 'Not found' });

    db.prepare('DELETE FROM receipts WHERE id = ?').run(id);
    return reply.send({ deleted: true });
  });

  // ── POST /api/receipts/:id/re-import ──────────────────────────────────────
  fastify.post('/api/receipts/:id/re-import', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return reply.code(404).send({ error: 'Not found' });

    const receipt = db.prepare('SELECT id, pdf_path FROM receipts WHERE id = ?').get(id);
    if (!receipt) return reply.code(404).send({ error: 'Not found' });

    if (!fs.existsSync(receipt.pdf_path)) {
      return reply.code(500).send({ error: `PDF no longer exists: ${receipt.pdf_path}` });
    }

    await processOnePdf(receipt.pdf_path);

    const updated = db.prepare(`
      SELECT ${receiptColumns()} FROM receipts WHERE id = ?
    `).get(id);

    return reply.send(updated);
  });
}
