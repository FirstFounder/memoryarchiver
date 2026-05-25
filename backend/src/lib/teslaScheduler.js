import cron from 'node-cron';
import db from '../db/client.js';
import config from '../config.js';
import { computePlan, pushPlan } from './chargeScheduler.js';

let scheduledTask = null;
let running = false;

function getActiveVehicles() {
  return db.prepare(`
    SELECT vin, display_name, nickname
    FROM tesla_config
    WHERE mode = 'active'
    ORDER BY created_at, id
  `).all();
}

export async function runEveningScheduler() {
  if (running) return;
  running = true;
  try {
    const vehicles = getActiveVehicles();
    for (const vehicle of vehicles) {
      try {
        const plan = await computePlan(vehicle.vin);
        if (plan?.status === 'skipped') {
          console.info(`[teslaScheduler] ${vehicle.display_name ?? vehicle.vin}: skipped (${plan.reason ?? 'no_reason'})`);
          continue;
        }
        const pushed = await pushPlan(plan, vehicle.vin);
        console.info(`[teslaScheduler] ${vehicle.display_name ?? vehicle.vin}: ${pushed?.alert ?? 'scheduled'}`);
      } catch (error) {
        console.error(`[teslaScheduler] ${vehicle.display_name ?? vehicle.vin}:`, error);
      }
    }
  } finally {
    running = false;
  }
}

export async function startTeslaScheduler() {
  if (!config.teslaEnabled || scheduledTask) return;

  const settings = db.prepare('SELECT eval_cron FROM tesla_settings WHERE id = 1').get();
  const expression = settings?.eval_cron ?? '0 19 * * *';

  scheduledTask = cron.schedule(expression, () => {
    runEveningScheduler().catch(err => {
      console.error('[teslaScheduler] unhandled error', err);
    });
  }, { timezone: 'America/Chicago' });

  console.info(`[teslaScheduler] scheduled with cron "${expression}"`);
}

export function stopTeslaScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}
