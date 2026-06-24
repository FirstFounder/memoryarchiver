import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '../../scripts');
const PYTHON = '/bin/python3';

const PYTHON_ENV = {
  ...process.env,
  PYTHONPATH: '/var/services/homes/philander/.local/lib/python3.8/site-packages'
};

function runScript(scriptName, log) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(SCRIPTS_DIR, scriptName);
    log.info({ scriptPath }, `[maevingRateScraper] spawning ${scriptName}`);
    const proc = spawn(PYTHON, [scriptPath], { env: PYTHON_ENV });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          reject(new Error(`${scriptName} produced invalid JSON: ${stdout}`));
        }
      } else {
        reject(new Error(`${scriptName} exited ${code}: ${stderr.trim()}`));
      }
    });
    proc.on('error', err => reject(err));
  });
}

export async function scrapeMonthlyRates(db, log) {
  const now = new Date();
  const rateMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  db.prepare(`
    INSERT OR IGNORE INTO maeving_monthly_rates (rate_month)
    VALUES (?)
  `).run(rateMonth);

  const results = { cfra: 'fail', pea: 'fail' };

  // --- CFRA ---
  try {
    const cfra = await runScript('scrape_cfra.py', log);
    const status = cfra.cfra_partial ? 'partial' : 'ok';
    db.prepare(`
      UPDATE maeving_monthly_rates
      SET cfra_cents = ?, cfra_partial = ?, cfra_status = ?, cfra_fetched_at = datetime('now'), updated_at = datetime('now')
      WHERE rate_month = ?
    `).run(cfra.cfra_cents, cfra.cfra_partial ? 1 : 0, status, rateMonth);
    results.cfra = status;
    log.info({ rateMonth, cfra_cents: cfra.cfra_cents, partial: cfra.cfra_partial }, '[maevingRateScraper] CFRA ok');
  } catch (err) {
    db.prepare(`
      UPDATE maeving_monthly_rates
      SET cfra_status = 'fail', updated_at = datetime('now')
      WHERE rate_month = ?
    `).run(rateMonth);
    log.warn({ err: err.message }, '[maevingRateScraper] CFRA scrape failed');
  }

  // --- PEA ---
  try {
    const pea = await runScript('scrape_pea.py', log);
    db.prepare(`
      UPDATE maeving_monthly_rates
      SET pea_cents = ?, pea_status = 'ok', pea_fetched_at = datetime('now'), updated_at = datetime('now')
      WHERE rate_month = ?
    `).run(pea.pea_cents, rateMonth);
    results.pea = 'ok';
    log.info({ rateMonth, pea_cents: pea.pea_cents }, '[maevingRateScraper] PEA ok');
  } catch (err) {
    db.prepare(`
      UPDATE maeving_monthly_rates
      SET pea_status = 'fail', updated_at = datetime('now')
      WHERE rate_month = ?
    `).run(rateMonth);
    log.warn({ err: err.message }, '[maevingRateScraper] PEA scrape failed');
  }

  return results;
}

export function getCurrentMonthRates(db) {
  const now = new Date();
  const rateMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return db.prepare(`
    SELECT rate_month, cfra_cents, cfra_partial, cfra_status, pea_cents, pea_status,
           cfra_fetched_at, pea_fetched_at
    FROM maeving_monthly_rates
    WHERE rate_month = ?
  `).get(rateMonth) ?? null;
}
