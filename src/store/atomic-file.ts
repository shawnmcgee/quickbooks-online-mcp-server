import crypto from "crypto";
import { promises as fsp } from "fs";
import path from "path";

/**
 * Backoff between attempts, in milliseconds (five attempts in all, about 1.5s).
 * On Windows a rename or credential write can fail with EPERM/EBUSY/EACCES
 * while another process (antivirus, a search indexer, a sibling server) holds
 * the target open; that usually clears within a second.
 */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [100, 200, 400, 800];

export interface RetryOptions {
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run `op`, retrying after each delay in turn; rethrows the last error. */
export async function withRetry<T>(op: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (attempt >= delays.length) throw err;
      await sleep(delays[attempt]);
    }
  }
}

export interface AtomicWriteOptions extends RetryOptions {
  /** Test seam; defaults to fs.promises. */
  fs?: Pick<typeof fsp, "mkdir" | "open" | "rename" | "unlink">;
}

/**
 * Replace `target` with `data` so that a crash at any point leaves either the
 * old file or the new one, never a partial file: write a sibling temp file,
 * flush it to disk, then rename it over the target. Each attempt uses a fresh
 * temp file, and a failed attempt removes its temp file before retrying.
 */
export async function writeFileAtomic(
  target: string,
  data: string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const fs = options.fs ?? fsp;
  // 0o700 / 0o600 only matter on POSIX; on Windows the per-user profile
  // directory's ACL is what keeps the file private.
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await withRetry(async () => {
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      const handle = await fs.open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(data, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  }, options);
}
