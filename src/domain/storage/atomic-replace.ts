import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

type ReplacementIO = {
  platform: NodeJS.Platform;
  rename(source: string, destination: string): Promise<void>;
  delay(ms: number): Promise<unknown>;
};

/** Windows readers/scanners can briefly deny rename even under our writer lease.
 * Retry the same atomic replacement while retaining ownership. Never unlink the
 * destination: readers must see either the previous record or the committed one.
 */
export async function atomicReplace(
  source: string, destination: string, lease: { assertOwned(): Promise<void> },
  io: ReplacementIO = { platform: process.platform, rename, delay },
): Promise<void> {
  const backoff = [8, 16, 32, 64, 128, 256, 256, 256];
  for (let attempt = 0; ; attempt++) {
    await lease.assertOwned();
    try { await io.rename(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (io.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= backoff.length) throw error;
      await io.delay(backoff[attempt]);
    }
  }
}
