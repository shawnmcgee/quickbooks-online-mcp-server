import type { SecretStore } from '../../src/store/secret-store';

/** In-memory SecretStore for tests, with injectable failures. */
export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  readonly setCalls: Array<[string, string]> = [];
  /** How many upcoming set() calls fail with a Windows-style lock error. */
  failSets = 0;
  /** When set, get() rejects with this error. */
  getError?: Error;

  async get(key: string): Promise<string | undefined> {
    if (this.getError) throw this.getError;
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.setCalls.push([key, value]);
    if (this.failSets > 0) {
      this.failSets--;
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

/** Retry options that never wait. */
export const noWait = { delaysMs: [0, 0, 0, 0], sleep: async () => {} };
