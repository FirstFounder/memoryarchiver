import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import db from '../../db/client.js';
import config from '../../config.js';
import { extractTextPages } from '../../lib/ocr.js';
import { parsers } from '../../parsers/index.js';

// ── shared import logic ───────────────────────────────────────────────────────

async function importFile(filePath, vendorKey, force, sourceLabel) {
  const vendor = db.prepare('SELECT id FROM receipt_vendors WHERE key = ?').get(vendorKey);
  if (!vendor) throw Object.assign(new Error(`Unknown vendor: ${vendorKey}`), { status: 400 });

  const parser = parsers[vendorKey];
  if (!parser) throw Object.assign(new Error(`No parser registered for vendor: ${vendorKey}`), { status: 400 });

  const pages = await extractTextPages(filePath);
  const receiptsOut = [];

  for (const pageText of pages) {
    const warnings = [];

    if (pageText.startsWith('[WARNING:')) {
      warnings.push(pageText);
    }

    const parsed = parser.parse(pageText);
    if (!parsed) continue;

    const itemCount = parsed.items.length;
    const purchaseAmount = parsed.total;

    if (!force) {
      const existing = db.prepare(
        'SELECT id FROM receipts WHERE vendor_id=? AND receipt_date=? AND purchase_amount=? AND item_count=?'
      ).get(vendor.id, parsed.date, purchaseAmount, itemCount);

      if (existing) {
        return { duplicate: true, existingReceiptId: existing.id };
      }
    }

    const result = db.transaction(() => {
      if (force) {
        const dup = db.prepare(
          'SELECT id FROM receipts WHERE vendor_id=? AND receipt_date=? AND purchase_amount=? AND item_count=?'
        ).get(vendor.id, parsed.date, purchaseAmount, itemCount);
        if (dup) {
          db.prepare('DELETE FROM receipt_line_items WHERE receipt_id=?').run(dup.id);
          db.prepare('DELETE FROM receipts WHERE id=?').run(dup.id);
        }
      }

      const { lastInsertRowid: receiptId } = db.prepare(`
        INSERT INTO receipts
          (vendor_id, receipt_date, purchase_amount, item_count, subtotal, tax_amount, store_number, source_file)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        vendor.id, parsed.date, purchaseAmount, itemCount,
        parsed.subtotal ?? null, parsed.tax_amount ?? null,
        parsed.store_number ?? null, sourceLabel
      );

      let newItemTypes = 0;

      parsed.items.forEach((item, i) => {
        let itemType = db.prepare(
          'SELECT id FROM receipt_item_types WHERE vendor_id=? AND description=?'
        ).get(vendor.id, item.description);

        if (!itemType) {
          const { lastInsertRowid } = db.prepare(`
            INSERT INTO receipt_item_types (vendor_id, description)
            VALUES (?, ?)
          `).run(vendor.id, item.description);
          itemType = { id: lastInsertRowid };
          newItemTypes++;
        }

        db.prepare(`
          INSERT INTO receipt_line_items
            (receipt_id, item_type_id, description, price, price_code, is_weight_item, quantity, unit_price, line_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          Number(receiptId), itemType.id, item.description,
          item.price, item.price_code ?? null,
          item.is_weight_item ? 1 : 0,
          item.quantity ?? null, item.unit_price ?? null, i
        );
      });

      return { receiptId: Number(receiptId), itemCount, newItemTypes, warnings };
    })();

    receiptsOut.push(result);
  }

  return { receipts: receiptsOut };
}

// ── route plugin ──────────────────────────────────────────────────────────────

export default async function receiptsRoutes(fastify) {

  // ── POST /api/receipts/upload ─────────────────────────────────────────────
  // Accepts a multipart PDF upload.  vendorKey must be provided as a form field.
  fastify.post('/api/receipts/upload', { config: { bodyTimeout: 0 } }, async (req, reply) => {
    let fileBuffer = null;
    let origName   = null;
    let vendorKey  = null;

    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const chunks = [];
        for await (const chunk of part.file) chunks.push(chunk);
        fileBuffer = Buffer.concat(chunks);
        origName   = part.filename;
      } else {
        const val = await part.value;
        if (part.fieldname === 'vendorKey') vendorKey = val;
      }
    }

    if (!fileBuffer || !origName) return reply.code(400).send({ error: 'No file uploaded' });
    if (!vendorKey) return reply.code(400).send({ error: 'vendorKey field is required' });

    const ext = path.extname(origName).toLowerCase();
    if (ext !== '.pdf') return reply.code(400).send({ error: 'Only PDF files are accepted' });

    const tempPath = path.join(config.uploadTempDir, `receipt-${crypto.randomUUID()}.pdf`);
    fs.mkdirSync(config.uploadTempDir, { recursive: true });
    fs.writeFileSync(tempPath, fileBuffer);

    try {
      const force = req.query.force === '1';
      const result = await importFile(tempPath, vendorKey, force, origName);
      if (result.duplicate) {
        return reply.code(409).send({ duplicate: true, existingReceiptId: result.existingReceiptId });
      }
      return reply.code(201).send(result);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  });

  // ── POST /api/receipts/import-path ────────────────────────────────────────
  // Imports a file already on disk under receiptsInputDir.
  // Body: { filename: string, vendorKey: string }
  fastify.post('/api/receipts/import-path', async (req, reply) => {
    const { filename, vendorKey } = req.body ?? {};
    if (!filename) return reply.code(400).send({ error: 'filename is required' });
    if (!vendorKey) return reply.code(400).send({ error: 'vendorKey is required' });
    if (!config.receiptsInputDir) return reply.code(503).send({ error: 'RECEIPTS_INPUT_DIR not configured' });

    const filePath = path.resolve(config.receiptsInputDir, filename);
    // Prevent path traversal
    if (!filePath.startsWith(path.resolve(config.receiptsInputDir) + path.sep)) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }

    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: 'File not found' });

    const force = req.query.force === '1';
    const result = await importFile(filePath, vendorKey, force, filename);
    if (result.duplicate) {
      return reply.code(409).send({ duplicate: true, existingReceiptId: result.existingReceiptId });
    }
    return reply.code(201).send(result);
  });

  // ── GET /api/receipts ─────────────────────────────────────────────────────
  // Query params: vendor (key), includeDeleted (1)
  fastify.get('/api/receipts', async (req, reply) => {
    const { vendor, includeDeleted } = req.query;
    const conditions = ['1=1'];
    const params = [];

    if (!includeDeleted || includeDeleted !== '1') {
      conditions.push('r.deleted_at IS NULL');
    }
    if (vendor) {
      conditions.push('v.key = ?');
      params.push(vendor);
    }

    const rows = db.prepare(`
      SELECT r.id, r.receipt_date, r.purchase_amount, r.item_count,
             r.subtotal, r.tax_amount, r.store_number, r.source_file,
             r.imported_at, r.deleted_at,
             v.key AS vendor_key, v.name AS vendor_name
      FROM receipts r
      JOIN receipt_vendors v ON v.id = r.vendor_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY r.receipt_date DESC, r.imported_at DESC
    `).all(...params);

    return reply.send(rows);
  });

  // ── GET /api/receipts/vendors ─────────────────────────────────────────────
  fastify.get('/api/receipts/vendors', async (_req, reply) => {
    const rows = db.prepare('SELECT id, key, name, created_at FROM receipt_vendors ORDER BY name').all();
    return reply.send(rows);
  });

  // ── GET /api/receipts/item-types ──────────────────────────────────────────
  // Query params: vendor (key)
  fastify.get('/api/receipts/item-types', async (req, reply) => {
    const { vendor } = req.query;
    const rows = vendor
      ? db.prepare(`
          SELECT t.id, t.description, t.first_seen_at, v.key AS vendor_key
          FROM receipt_item_types t
          JOIN receipt_vendors v ON v.id = t.vendor_id
          WHERE v.key = ?
          ORDER BY t.description
        `).all(vendor)
      : db.prepare(`
          SELECT t.id, t.description, t.first_seen_at, v.key AS vendor_key
          FROM receipt_item_types t
          JOIN receipt_vendors v ON v.id = t.vendor_id
          ORDER BY t.description
        `).all();
    return reply.send(rows);
  });

  // ── GET /api/receipts/pending ─────────────────────────────────────────────
  // Lists PDFs in receiptsInputDir that have not yet been imported.
  fastify.get('/api/receipts/pending', async (_req, reply) => {
    if (!config.receiptsInputDir) return reply.send([]);

    let files;
    try {
      files = fs.readdirSync(config.receiptsInputDir)
        .filter(f => f.toLowerCase().endsWith('.pdf'))
        .sort();
    } catch {
      return reply.send([]);
    }

    const imported = new Set(
      db.prepare('SELECT source_file FROM receipts WHERE deleted_at IS NULL').all()
        .map(r => r.source_file)
    );

    return reply.send(files.filter(f => !imported.has(f)));
  });

  // ── GET /api/receipts/:id ─────────────────────────────────────────────────
  fastify.get('/api/receipts/:id', async (req, reply) => {
    const row = db.prepare(`
      SELECT r.id, r.receipt_date, r.purchase_amount, r.item_count,
             r.subtotal, r.tax_amount, r.store_number, r.source_file,
             r.imported_at, r.deleted_at,
             v.key AS vendor_key, v.name AS vendor_name
      FROM receipts r
      JOIN receipt_vendors v ON v.id = r.vendor_id
      WHERE r.id = ?
    `).get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'Not found' });
    return reply.send(row);
  });

  // ── GET /api/receipts/:id/items ───────────────────────────────────────────
  fastify.get('/api/receipts/:id/items', async (req, reply) => {
    const receipt = db.prepare('SELECT id FROM receipts WHERE id=?').get(Number(req.params.id));
    if (!receipt) return reply.code(404).send({ error: 'Not found' });

    const rows = db.prepare(`
      SELECT li.id, li.description, li.price, li.price_code,
             li.is_weight_item, li.quantity, li.unit_price, li.line_order,
             t.id AS item_type_id
      FROM receipt_line_items li
      LEFT JOIN receipt_item_types t ON t.id = li.item_type_id
      WHERE li.receipt_id = ?
      ORDER BY li.line_order
    `).all(Number(req.params.id));

    return reply.send(rows);
  });

  // ── DELETE /api/receipts/:id ──────────────────────────────────────────────
  // Soft delete: sets deleted_at timestamp.
  fastify.delete('/api/receipts/:id', async (req, reply) => {
    const row = db.prepare('SELECT id, deleted_at FROM receipts WHERE id=?').get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'Not found' });
    if (row.deleted_at) return reply.code(409).send({ error: 'Already deleted' });

    db.prepare(
      `UPDATE receipts SET deleted_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`
    ).run(Number(req.params.id));

    return reply.send({ id: Number(req.params.id), deleted: true });
  });

  // ── POST /api/receipts/:id/restore ────────────────────────────────────────
  fastify.post('/api/receipts/:id/restore', async (req, reply) => {
    const row = db.prepare('SELECT id, deleted_at FROM receipts WHERE id=?').get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'Not found' });
    if (!row.deleted_at) return reply.code(409).send({ error: 'Not deleted' });

    db.prepare('UPDATE receipts SET deleted_at=NULL WHERE id=?').run(Number(req.params.id));
    return reply.send({ id: Number(req.params.id), restored: true });
  });
}
