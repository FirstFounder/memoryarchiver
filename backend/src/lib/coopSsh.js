import { exec } from 'child_process';
import { promisify } from 'util';
import config from '../config.js';

const execAsync = promisify(exec);

/**
 * Run a command on janus via SSH.
 * @param {string} command  Shell command to execute on janus.
 * @param {number} timeoutMs  Default 10000ms. Use 120000 for door move operations.
 * @returns {Promise<string>}  stdout trimmed.
 * @throws on non-zero exit or timeout.
 */
export async function janusExec(command, timeoutMs = 10_000) {
  const sshCmd =
    `ssh -i "${config.coopSshKey}" -o IdentitiesOnly=yes ` +
    `-o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 ` +
    `root@${config.coopJanusIp} '${command}'`;
  const { stdout } = await execAsync(sshCmd, { timeout: timeoutMs });
  return stdout.trim();
}
