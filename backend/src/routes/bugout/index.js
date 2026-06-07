import db from '../../db/client.js';

const VALID_PROFILES = new Set(['graham', 'meredith', 'calvin', 'bigchicken', 'dad']);

function validateProfile(profile, reply) {
  if (!VALID_PROFILES.has(profile)) {
    reply.code(400).send({ error: `Invalid profile: ${profile}` });
    return false;
  }
  return true;
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
    return reply.send(rows);
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
    return reply.code(201).send(row);
  });

  fastify.put('/api/bugout/:profile/items/:id', async (req, reply) => {
    if (!validateProfile(req.params.profile, reply)) return;
    const { name, description, tags, is_overnight, is_hidden, sort_order } = req.body ?? {};
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

    if (fields.length === 0) return reply.code(400).send({ error: 'No fields to update' });

    values.push(req.params.id, req.params.profile);
    db.prepare(`UPDATE bugout_items SET ${fields.join(', ')} WHERE id = ? AND profile = ?`).run(...values);
    const row = db.prepare('SELECT * FROM bugout_items WHERE id = ?').get(req.params.id);
    return reply.send(row);
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
    return reply.send(rows);
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
    return reply.code(201).send(row);
  });

  fastify.put('/api/bugout/:profile/activities/:id', async (req, reply) => {
    if (!validateProfile(req.params.profile, reply)) return;
    const { name, description, tags, is_overnight, is_hidden, sort_order } = req.body ?? {};
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

    if (fields.length === 0) return reply.code(400).send({ error: 'No fields to update' });

    values.push(req.params.id, req.params.profile);
    db.prepare(`UPDATE bugout_activities SET ${fields.join(', ')} WHERE id = ? AND profile = ?`).run(...values);
    const row = db.prepare('SELECT * FROM bugout_activities WHERE id = ?').get(req.params.id);
    return reply.send(row);
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
    // Delete auto-item rows for this activity_id where the item's entity_id
    // does not appear as auto_from_activity_id in any other remaining activity checklist row.
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
