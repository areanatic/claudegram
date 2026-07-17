import { spawn } from 'node:child_process';

/**
 * Uses the existing independent Dirigent ping path. It is deliberately not the
 * failing bot API, so an init-401 can still surface to the operator.
 */
export async function sendStartupFailureAlert(scriptPath: string, message: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(scriptPath, ['--strict', message], {
      stdio: 'ignore',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`telegram-ping exited with ${code ?? 'signal'}`)));
  });
}
