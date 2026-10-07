import { jest, describe, it, expect } from '@jest/globals';
import crypto from 'crypto';
import { KEYRING_SERVICE, KeyringSecretStore, SecretStoreUnavailableError } from '../../../src/store/secret-store';

/** Stand-in for @napi-rs/keyring backed by a Map, recording how entries are built. */
function fakeKeyring(options: { constructorError?: unknown } = {}) {
  const values = new Map<string, string>();
  const constructed: unknown[][] = [];
  class AsyncEntry {
    constructor(
      readonly service: string,
      readonly user: string,
      readonly opts: unknown
    ) {
      constructed.push([service, user, opts]);
      if (options.constructorError !== undefined) throw options.constructorError;
    }
    async getPassword() {
      return values.get(`${this.service}/${this.user}`);
    }
    async setPassword(value: string) {
      values.set(`${this.service}/${this.user}`, value);
    }
    async deleteCredential() {
      return values.delete(`${this.service}/${this.user}`);
    }
  }
  return { module: { AsyncEntry } as any, values, constructed };
}

describe('KeyringSecretStore', () => {
  it('stores, reads and deletes secrets under the qbo-mcp service', async () => {
    const keyring = fakeKeyring();
    const store = new KeyringSecretStore(undefined, async () => keyring.module);

    await expect(store.get('sandbox:1')).resolves.toBeUndefined();
    await store.set('sandbox:1', 'token-1');
    await expect(store.get('sandbox:1')).resolves.toBe('token-1');
    expect(keyring.values.get(`${KEYRING_SERVICE}/sandbox:1`)).toBe('token-1');

    await store.delete('sandbox:1');
    await store.delete('sandbox:1'); // already gone: still succeeds
    await expect(store.get('sandbox:1')).resolves.toBeUndefined();
  });

  it('pins Linux to the Secret Service so it never silently uses the non-persistent kernel keyring', async () => {
    const keyring = fakeKeyring();
    await new KeyringSecretStore('svc', async () => keyring.module).get('k');
    expect(keyring.constructed).toEqual([['svc', 'k', { linux: { store: 'secret-service' } }]]);
  });

  it('maps a null password to undefined', async () => {
    const keyring = fakeKeyring();
    keyring.module.AsyncEntry.prototype.getPassword = async () => null;
    await expect(new KeyringSecretStore('svc', async () => keyring.module).get('k')).resolves.toBeUndefined();
  });

  it('reports a native module that fails to load, and tries again on the next call', async () => {
    const keyring = fakeKeyring();
    const load = jest
      .fn<() => Promise<any>>()
      .mockRejectedValueOnce(new Error('Cannot find native binding'))
      .mockResolvedValue(keyring.module);
    const store = new KeyringSecretStore('svc', load);

    const err = await store.get('k').catch((e) => e);
    expect(err).toBeInstanceOf(SecretStoreUnavailableError);
    expect(err.message).toBe('The OS credential store could not be loaded: Cannot find native binding');

    await expect(store.get('k')).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reports a credential store that is unavailable, with no plaintext fallback', async () => {
    const store = new KeyringSecretStore('svc', async () => fakeKeyring({ constructorError: 'DBus error' }).module);
    await expect(store.set('k', 'v')).rejects.toThrow(
      new SecretStoreUnavailableError('The OS credential store is unavailable: DBus error')
    );
  });

  it('loads the real native module by default', async () => {
    // On Linux without a Secret Service this reports the store unavailable; on
    // Windows and macOS it reads the real store, where this key does not exist.
    const result = await new KeyringSecretStore()
      .get(`qbo-mcp-test:absent:${crypto.randomUUID()}`)
      .catch((e: unknown) => e);
    if (result !== undefined) expect(result).toBeInstanceOf(SecretStoreUnavailableError);
  });
});

// The real Windows Credential Manager. Runs on the windows-latest CI job.
(process.platform === 'win32' ? describe : describe.skip)('KeyringSecretStore on Windows Credential Manager', () => {
  it('round-trips, overwrites and deletes a credential', async () => {
    const store = new KeyringSecretStore('qbo-mcp-test');
    const key = `sandbox:${crypto.randomUUID()}`;
    try {
      await store.set(key, 'first-token');
      await expect(store.get(key)).resolves.toBe('first-token');
      await store.set(key, 'rotated-token');
      await expect(store.get(key)).resolves.toBe('rotated-token');
    } finally {
      await store.delete(key);
    }
    await expect(store.get(key)).resolves.toBeUndefined();
  });
});
