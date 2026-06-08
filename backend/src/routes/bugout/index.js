import db from '../../db/client.js';

const VALID_PROFILES = new Set(['graham', 'meredith', 'calvin', 'bigchicken', 'dad']);

function validateProfile(profile, reply) {
  if (!VALID_PROFILES.has(profile)) {
    reply.code(400).send({ error: `Invalid profile: ${profile}` });
    return false;
  }
  return true;
}

function enrichWithSharedWith(rows, profile, table) {
  return rows.map(row => {
    if (row.origin_profile) return row; // copy — no shared_with
    const copies = db.prepare(
      `SELECT profile FROM ${table} WHERE origin_profile = ? AND origin_id = ?`
    ).all(profile, row.id);
    return { ...row, shared_with: copies.map(c => c.profile) };
  });
}

function applySharing(profile, id, shared_with, table) {
  if (!Array.isArray(shared_with)) return;
  const original = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!original) return;

  const existing = db.prepare(
    `SELECT profile FROM ${table} WHERE origin_profile = ? AND origin_id = ?`
  ).all(profile, id);
  const existingSet = new Set(existing.map(e => e.profile));
  const newSet = new Set(shared_with.filter(p => VALID_PROFILES.has(p) && p !== profile));

  for (const target of newSet) {
    if (!existingSet.has(target)) {
      db.prepare(
        `INSERT INTO ${table} (profile, name, description, tags, is_overnight, sort_order, origin_profile, origin_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(target, original.name, original.description, original.tags,
             original.is_overnight, original.sort_order, profile, id);
    }
  }

  for (const gone of existingSet) {
    if (!newSet.has(gone)) {
      db.prepare(
        `DELETE FROM ${table} WHERE origin_profile = ? AND origin_id = ? AND profile = ?`
      ).run(profile, id, gone);
    }
  }
}

export default async function bugoutRoutes(fastify) {
  // ── Items ──────────────────────────────────────────────────────────────────

  fastify.get('/api/bugout/:profile/items', async (req, reply) => {
    if (!validateProfile(req.params.profile, reply)) return;
    const rows = db.prepare(`
      SELECT * FROM bugout_items
      WHERE profile = ?
      ORDER BY sort_order ASC, id ASC
    `).all(req.params.profile);
    return reply.send(enrichWithSharedWith(rows, req.params.profile, 'bugout_items'));
  });

  fastify.post('/api/bugout/:profile/items', async (req, reply) => {
    if (!validateProfile(req.params.profile, reply)) return;
    const { name, description, tags, is_overnight, sort_order } = req.body ?? {};
    if (!name) return reply.code(400).send({ error: 'name is required' });
    const result = db.prepare(`
      INSERT INTO bugout_items (profile, name, description, tags, is_overnight, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.params.profile,
      name,
      description ?? null,
      tags ?? '',
      is_overnight ? 1 : 0,
      sort_order ?? 0,
    );
    const row = db.prepare('SELECT * FROM bugout_items WHERE id = ?').get(result.lastInsertRowid);
    return reply.code(201).send({ ...row, shared_with: [] });
  });

  fastify.put('/api/bugout/:profile/items/:id', async (req, reply) => {
    if (!validateProfile(req.params.profile, reply)) return;
    const { name, description, tags, is_overnight, is_hidden, sort_order, shared_with } = req.body ?? {};
    const existing = db.prepare('SELECT id FROM bugout_items WHERE id = ? AND profile = ?')
      .get(req.params.id, req.params.profile);
    if (!existing) return reply.code(404).send({ error: 'Item not found' });

    const fields = [];
    const values = [];
    if (name !== undefined)        { fields.push('name = ?');        values.push(name); }
    if (description !== undefined) { fields.push('description = ?'); values.push(description); }
    if (tags !== undefined)        { fields.push('tags = ?');        values.push(tags); }
    if (is_overnight !== undefined){ fields.push('is_overnight = ?');values.push(is_overnight ? 1 : 0); }
    if (is_hidden !== undefined)   { fields.push('is_hidden = ?');   values.push(is_hidden ? 1 : 0); }
    if (sort_order !== undefined)  { fields.push('sort_order = ?');  values.push(sort_order); }

    if (fields.length > 0) {
      values.push(req.params.id, req.params.profile);
      db.prepare(`UPDATE bugout_items SET ${fields.join(', ')} WHERE id = ? AND profile = ?`).run(...values);
    }

    applySharing(req.params.profile, req.params.id, shared_with, 'bugout_items');

    const row = db.prepare('SELECT * FROM bugout_items WHERE id = ?').get(req.params.id);
    const copies = db.prepare(
      'SELECT profile FROM bugout_items WHERE origin_profile = ? AND origin_id = ?'
    ).all(req.params.profile, req.params.id);
    return reply.send({ ...row, shared_with: copies.map(c => c.profile) });
  });

  fastify.delete('/api/bugout/:profile/items/:id', async (req, reply) => {
    if (!validateProfile(req.params.profile, reply)) return;
    db.prepare('DELETE FROM bugout_checklist WHERE profile = ? AND entity_type = ? AND entity_id = ?')
      .run(req.params.profile, 'item', req.params.id);
    db.prepare('DELETE FROM bugout_items WHERE id = ? AND profile = ?')
      .run(req.params.id, req.params.profile);
    return reply.code(204).send();
  });

  // ── Activities ─────────────────────────────────────────────────────────────

  fastify.get('/api/bugout/:profile/activities', async (req, reply) => {
    if (!validateProfile(req.params.profile, reply)) return;
    const rows = db.prepare(`
      SELECT * FROM bugout_activities
      WHERE profile = ?
      ORDER BY sort_order ASC, id ASC
    `).all(req.params.profile);
    return reply.send(enrichWithSharedWith(rows, req.params.profile, 'bugout_activities'));
  });

  fastify.post('/api/bugout/:profile/activities', async (req, reply) => {
    if (!validateProfile(req.params.profile, reply)) return;
    const { name, description, tags, is_overnight, sort_order } = req.body ?? {};
    if (!name) return reply.code(400).send({ error: 'name is required' });
    const result = db.prepare(`
      INSERT INTO bugout_activities (profile, name, description, tags, is_overnight, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.params.profile,
      name,
      description ?? null,
      tags ?? '',
      is_overnight ? 1 : 0,
      sort_order ?? 0,
    );
    const row = db.prepare('SELECT * FROM bugout_activities WHERE id = ?').get(result.lastInsertRowid);
    return reply.code(201).send({ ...row, shared_with: [] });
  });

  fastify.put('/api/bugout/:profile/activities/:id', async (req, reply) => {
    if (!validateProfile(req.params.profile, reply)) return;
    const { name, description, tags, is_overnight, is_hidden, sort_order, shared_with } = req.body ?? {};
    const existing = db.prepare('SELECT id FROM bugout_activities WHERE id = ? AND profile = ?')
      .get(req.params.id, req.params.profile);
    if (!existing) return reply.code(404).send({ error: 'Activity not found' });

    const fields = [];
    const values = [];
    if (name !== undefined)        { fields.push('name = ?');        values.push(name); }
    if (description !== undefined) { fields.push('description = ?'); values.push(description); }
    if (tags !== undefined)        { fields.push('tags = ?');        values.push(tags); }
    if (is_overnight !== undefined){ fields.push('is_overnight = ?');values.push(is_overnight ? 1 : 0); }
    if (is_hidden !== undefined)   { fields.push('is_hidden = ?');   values.push(is_hidden ? 1 : 0); }
    if (sort_order !== undefined)  { fields.push('sort_order = ?');  values.push(sort_order); }

    if (fields.length > 0) {
      values.push(req.params.id, req.params.profile);
      db.prepare(`UPDATE bugout_activities SET ${fields.join(', ')} WHERE id = ? AND profile = ?`).run(...values);
    }

    applySharing(req.params.profile, req.params.id, shared_with, 'bugout_activities');

    const row = db.prepare('SELECT * FROM bugout_activities WHERE id = ?').get(req.params.id);
    const copies = db.prepare(
      'SELECT profile FROM bugout_activities WHERE origin_profile = ? AND origin_id = ?'
    ).all(req.params.profile, req.params.id);
    return reply.send({ ...row, shared_with: copies.map(c => c.profile) });
  });

  fastify.delete('/api/bugout/:profile/activities/:id', async (req, reply) => {
    if (!validateProfile(req.params.profile, reply)) return;
    db.prepare('DELETE FROM bugout_checklist WHERE profile = ? AND entity_type = ? AND entity_id = ?')
      .run(req.params.profile, 'activity', req.params.id);
    db.prepare('DELETE FROM bugout_activities WHERE id = ? AND profile = ?')
      .run(req.params.id, req.params.profile);
    return reply.code(204).send();
  });

  // ── Checklist ──────────────────────────────────────────────────────────────

  fastify.get('/api/bugout/:profile/checklist', async (req, reply) => {
    if (!validateProfile(req.params.profile, reply)) return;
    const rows = db.prepare(`
      SELECT * FROM bugout_checklist WHERE profile = ?
    `).all(req.params.profile);
    return reply.send(rows);
  });

  fastify.post('/api/bugout/:profile/checklist', async (req, reply) => {
    if (!validateProfile(req.params.profile, reply)) return;
    const { entity_type, entity_id, is_checked, source, auto_from_activity_id } = req.body ?? {};
    if (!entity_type || entity_id == null) {
      return reply.code(400).send({ error: 'entity_type and entity_id are required' });
    }
    db.prepare(`
      INSERT OR REPLACE INTO bugout_checklist
        (profile, entity_type, entity_id, is_checked, source, auto_from_activity_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.params.profile,
      entity_type,
      entity_id,
      is_checked ? 1 : 0,
      source ?? 'manual',
      auto_from_activity_id ?? null,
    );
    const row = db.prepare(`
      SELECT * FROM bugout_checklist
      WHERE profile = ? AND entity_type = ? AND entity_id = ?
    `).get(req.params.profile, entity_type, entity_id);
    return reply.send(row);
  });

  fastify.delete('/api/bugout/:profile/checklist/:entity_type/:entity_id', async (req, reply) => {
    if (!validateProfile(req.params.profile, reply)) return;
    db.prepare(`
      DELETE FROM bugout_checklist
      WHERE profile = ? AND entity_type = ? AND entity_id = ?
    `).run(req.params.profile, req.params.entity_type, req.params.entity_id);
    return reply.code(204).send();
  });

  fastify.delete('/api/bugout/:profile/checklist/auto/:activity_id', async (req, reply) => {
    if (!validateProfile(req.params.profile, reply)) return;
    const activityId = Number(req.params.activity_id);
    db.prepare(`
      DELETE FROM bugout_checklist
      WHERE profile = ?
        AND entity_type = 'item'
        AND source = 'auto'
        AND auto_from_activity_id = ?
        AND entity_id NOT IN (
          SELECT auto_from_activity_id
          FROM bugout_checklist
          WHERE profile = ?
            AND entity_type = 'item'
            AND source = 'auto'
            AND auto_from_activity_id != ?
            AND auto_from_activity_id IS NOT NULL
        )
    `).run(req.params.profile, activityId, req.params.profile, activityId);
    return reply.code(204).send();
  });
}
