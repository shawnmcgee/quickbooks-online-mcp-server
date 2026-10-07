import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_RETRY_DELAYS_MS, withRetry, writeFileAtomic } from '../../../src/store/atomic-file';

const lockError = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });

describe('withRetry', () => {
  it('returns the first successful result without sleeping', async () => {
    const sleep = jest.fn(async (_ms: number) => {});
    await expect(withRetry(async () => 'ok', { sleep })).resolves.toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
    await expect(withRetry(async () => 'no options')).resolves.toBe('no options');
  });

  it('retries after each delay until the operation succeeds', async () => {
    const sleep = jest.fn(async (_ms: number) => {});
    let calls = 0;
    const op = async () => {
      if (++calls < 3) throw lockError();
      return calls;
    };
    await expect(withRetry(op, { delaysMs: [10, 20, 30], sleep })).resolves.toBe(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it('rethrows the last error once every delay is used up', async () => {
    const sleep = jest.fn(async (_ms: number) => {});
    let calls = 0;
    const op = async () => {
      calls++;
      throw new Error(`attempt ${calls}`);
    };
    await expect(withRetry(op, { delaysMs: [1, 2], sleep })).rejects.toThrow('attempt 3');
    expect(calls).toBe(3);
  });

  it('waits with real timers when no sleep is given', async () => {
    let calls = 0;
    const op = async () => {
      if (++calls === 1) throw lockError();
      return 'second';
    };
    await expect(withRetry(op, { delaysMs: [0] })).resolves.toBe('second');
  });

  it('defaults to five attempts with backoff', () => {
    expect(DEFAULT_RETRY_DELAYS_MS).toEqual([100, 200, 400, 800]);
  });
});

describe('writeFileAtomic on the real filesystem', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-atomic-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates missing directories and writes the file', async () => {
    const target = path.join(dir, 'nested', 'deeper', 'companies.json');
    await writeFileAtomic(target, '{"a":1}');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}');
  });

  it('replaces an existing file and leaves no temp files behind', async () => {
    const target = path.join(dir, 'companies.json');
    fs.writeFileSync(target, 'old');
    await writeFileAtomic(target, 'new');
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['companies.json']);
  });

  (process.platform === 'win32' ? it.skip : it)('makes the file readable by its owner only (POSIX)', async () => {
    const target = path.join(dir, 'companies.json');
    await writeFileAtomic(target, 'x');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });
});

describe('writeFileAtomic with a failing filesystem', () => {
  function fakeFs(options: { renameFailures?: number; writeFails?: boolean; unlinkFails?: boolean } = {}) {
    let renameFailures = options.renameFailures ?? 0;
    const handle = {
      writeFile: jest.fn(async () => {
        if (options.writeFails) throw new Error('ENOSPC: no space left on device');
      }),
      sync: jest.fn(async () => {}),
      close: jest.fn(async () => {}),
    };
    const fake = {
      mkdir: jest.fn(async () => undefined),
      open: jest.fn(async (_path: string, _flags: string, _mode: number) => handle),
      rename: jest.fn(async (_from: string, _to: string) => {
        if (renameFailures > 0) {
          renameFailures--;
          throw lockError();
        }
      }),
      unlink: jest.fn(async () => {
        if (options.unlinkFails) throw new Error('ENOENT');
      }),
    };
    return { fake, handle };
  }
  const noWait = { delaysMs: [0, 0, 0, 0], sleep: async () => {} };

  it('retries a rename that Windows reports as locked, using a fresh temp file each time', async () => {
    const { fake } = fakeFs({ renameFailures: 2 });
    await writeFileAtomic('/store/companies.json', 'data', { ...noWait, fs: fake as any });

    expect(fake.rename).toHaveBeenCalledTimes(3);
    const temps = fake.open.mock.calls.map((c) => c[0]);
    expect(new Set(temps).size).toBe(3);
    expect(fake.unlink).toHaveBeenCalledTimes(2); // the two failed attempts cleaned up
    expect(fake.rename).toHaveBeenLastCalledWith(temps[2], '/store/companies.json');
    expect(fake.open).toHaveBeenCalledWith(expect.stringMatching(/^\/store\/companies\.json\.\d+\.[0-9a-f]{8}\.tmp$/), 'wx', 0o600);
  });

  it('gives up after the last retry and rethrows, cleaning up every temp file', async () => {
    const { fake } = fakeFs({ renameFailures: 99, unlinkFails: true });
    await expect(
      writeFileAtomic('/store/companies.json', 'data', { ...noWait, fs: fake as any })
    ).rejects.toThrow(/EPERM/);
    expect(fake.rename).toHaveBeenCalledTimes(5);
    expect(fake.unlink).toHaveBeenCalledTimes(5);
  });

  it('closes the temp file even when writing it fails', async () => {
    const { fake, handle } = fakeFs({ writeFails: true });
    await expect(
      writeFileAtomic('/store/companies.json', 'data', { delaysMs: [], fs: fake as any })
    ).rejects.toThrow(/ENOSPC/);
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(fake.rename).not.toHaveBeenCalled();
  });
});
