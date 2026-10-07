import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CompanyRegistry } from '../../../src/store/company-registry';
import { CompanyStore, ReconnectRequiredError, secretKey } from '../../../src/store/company-store';
import { MemorySecretStore, noWait } from '../../mocks/memory-secret-store';

let dir: string;
let registry: CompanyRegistry;
let secrets: MemorySecretStore;
let store: CompanyStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-store-'));
  registry = new CompanyRegistry(path.join(dir, 'companies.json'), noWait);
  secrets = new MemorySecretStore();
  store = new CompanyStore(registry, secrets, noWait);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const acme = { name: 'Acme', realmId: '111', environment: 'sandbox' as const, refreshToken: 'rt-1' };

describe('secretKey', () => {
  it('keys a token by environment and realm', () => {
    expect(secretKey('production', '42')).toBe('production:42');
  });
});

describe('ReconnectRequiredError', () => {
  it('names the company and says what to do, with or without a detail', () => {
    const company = { name: 'Acme', realmId: '111', environment: 'sandbox' as const };
    expect(new ReconnectRequiredError(company).message).toBe(
      '"Acme" (sandbox, realm 111) needs to be reconnected to QuickBooks. Reconnect this company, then try again.'
    );
    const err = new ReconnectRequiredError(company, 'token rejected');
    expect(err.message).toContain('needs to be reconnected to QuickBooks (token rejected).');
    expect(err.name).toBe('ReconnectRequiredError');
  });
});

describe('CompanyStore.addCompany / removeCompany', () => {
  it('saves the token in the credential store and the company in the registry', async () => {
    const record = await store.addCompany(acme);
    expect(record).toMatchObject({ name: 'Acme', realmId: '111', status: 'connected' });
    expect(secrets.values.get('sandbox:111')).toBe('rt-1');
    expect(fs.readFileSync(registry.filePath, 'utf8')).not.toContain('rt-1'); // no token in the file
  });

  it('uses the default retry policy when none is given', async () => {
    await new CompanyStore(registry, secrets).addCompany(acme);
    expect(secrets.values.get('sandbox:111')).toBe('rt-1');
  });

  it('retries a credential write that fails transiently', async () => {
    secrets.failSets = 2;
    await store.addCompany(acme);
    expect(secrets.setCalls).toHaveLength(3);
    expect(secrets.values.get('sandbox:111')).toBe('rt-1');
  });

  it('does not list the company if its token could not be saved', async () => {
    secrets.failSets = 99;
    await expect(store.addCompany(acme)).rejects.toThrow(/EPERM/);
    await expect(registry.list()).resolves.toEqual([]);
  });

  it('writes the token before the registry, so a failed registry write leaves only an orphan token', async () => {
    fs.writeFileSync(registry.filePath, '{ corrupt');
    await expect(store.addCompany(acme)).rejects.toThrow(/not valid JSON/);
    expect(secrets.values.get('sandbox:111')).toBe('rt-1');
  });

  it('on reconnect, supersedes a rotated token that was never saved', async () => {
    const record = await store.addCompany(acme);
    const connection = store.connection(record);
    secrets.failSets = 99;
    await expect(connection.saveRefreshToken('rt-rotated')).rejects.toThrow();
    expect(connection.saveWarning).toBeDefined();

    secrets.failSets = 0;
    const renamed = await store.addCompany({ ...acme, name: 'Acme Ltd', refreshToken: 'rt-fresh' });
    expect(connection.saveWarning).toBeUndefined();
    expect(connection.record).toEqual(renamed);
    await connection.flushPendingSave(); // nothing pending any more
    expect(secrets.values.get('sandbox:111')).toBe('rt-fresh');
  });

  it('removes the registry entry, then the token, and forgets the connection', async () => {
    const record = await store.addCompany(acme);
    const first = store.connection(record);
    await expect(store.removeCompany('sandbox', '111')).resolves.toBe(true);
    await expect(registry.list()).resolves.toEqual([]);
    expect(secrets.values.has('sandbox:111')).toBe(false);
    expect(store.connection(record)).not.toBe(first);
    await expect(store.removeCompany('sandbox', '111')).resolves.toBe(false);
  });
});

describe('CompanyConnection', () => {
  it('is one instance per company, updated with the latest record', async () => {
    const record = await store.addCompany(acme);
    const a = store.connection(record);
    const b = store.connection({ ...record, name: 'Renamed' });
    expect(b).toBe(a);
    expect(a.record.name).toBe('Renamed');
  });

  it('loads and saves the refresh token', async () => {
    const connection = store.connection(await store.addCompany(acme));
    await expect(connection.loadRefreshToken()).resolves.toBe('rt-1');
    await connection.saveRefreshToken('rt-2');
    await expect(connection.loadRefreshToken()).resolves.toBe('rt-2');
    expect(connection.saveWarning).toBeUndefined();
  });

  it('keeps an unsaved rotated token, warns about it, and saves it on a later flush', async () => {
    const connection = store.connection(await store.addCompany(acme));
    secrets.failSets = 99;
    await expect(connection.saveRefreshToken('rt-2')).rejects.toThrow(/EPERM/);
    expect(secrets.values.get('sandbox:111')).toBe('rt-1');
    expect(connection.saveWarning).toBe(
      'WARNING: QuickBooks issued a new sign-in token for "Acme", but it could not be saved ' +
        '(EPERM: operation not permitted). It is held in memory and saving will be retried. If Claude ' +
        'or the computer restarts before it is saved, "Acme" will need to be reconnected.'
    );

    await connection.flushPendingSave(); // still failing: does not reject
    expect(connection.saveWarning).toBeDefined();

    secrets.failSets = 0;
    await connection.flushPendingSave();
    expect(secrets.values.get('sandbox:111')).toBe('rt-2');
    expect(connection.saveWarning).toBeUndefined();

    const calls = secrets.setCalls.length;
    await connection.flushPendingSave(); // nothing pending
    expect(secrets.setCalls).toHaveLength(calls);
  });

  it('never lets an older token overwrite a newer one when saves overlap', async () => {
    const connection = store.connection(await store.addCompany(acme));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realSet = secrets.set.bind(secrets);
    const setSpy = jest.spyOn(secrets, 'set').mockImplementation(async (key, value) => {
      await gate;
      return realSet(key, value);
    });

    const first = connection.saveRefreshToken('rt-2');
    const second = connection.saveRefreshToken('rt-3');
    release();
    await Promise.all([first, second]);

    expect(secrets.values.get('sandbox:111')).toBe('rt-3');
    expect(setSpy.mock.calls.map((c) => c[1])).toEqual(['rt-3']); // rt-2 was superseded before it was written
  });

  it('keeps the newer token pending when an older save completes first', async () => {
    const connection = store.connection(await store.addCompany(acme));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realSet = secrets.set.bind(secrets);
    let first = true;
    jest.spyOn(secrets, 'set').mockImplementation(async (key, value) => {
      if (first) {
        first = false;
        await gate; // the rt-2 write is in flight when rt-3 arrives
      }
      return realSet(key, value);
    });

    const older = connection.saveRefreshToken('rt-2');
    await new Promise((r) => setImmediate(r));
    const newer = connection.saveRefreshToken('rt-3');
    release();
    await Promise.all([older, newer]);
    expect(secrets.values.get('sandbox:111')).toBe('rt-3');
  });

  it('describes a non-Error save failure', async () => {
    const connection = store.connection(await store.addCompany(acme));
    jest.spyOn(secrets, 'set').mockRejectedValue('credential store locked');
    await expect(connection.saveRefreshToken('rt-2')).rejects.toBe('credential store locked');
    expect(connection.saveWarning).toContain('(credential store locked)');
  });

  it('flags the company as needing reconnection and returns an error naming it', async () => {
    const connection = store.connection(await store.addCompany(acme));
    const err = await connection.reconnectRequired('Request failed with status code 400');
    expect(err).toBeInstanceOf(ReconnectRequiredError);
    expect(err.message).toContain('"Acme" (sandbox, realm 111) needs to be reconnected');
    expect(await registry.find('sandbox', '111')).toMatchObject({
      status: 'needs_reconnect',
      statusDetail: 'Request failed with status code 400',
    });
    expect(connection.record.status).toBe('needs_reconnect');
  });

  it('still returns the reconnect error when the registry cannot be updated', async () => {
    const connection = store.connection(await store.addCompany(acme));
    fs.writeFileSync(registry.filePath, '{ corrupt');
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const err = await connection.reconnectRequired();
    expect(err).toBeInstanceOf(ReconnectRequiredError);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Could not record that "Acme" needs reconnecting'));
  });

  it('describes a non-Error registry failure', async () => {
    const connection = store.connection(await store.addCompany(acme));
    jest.spyOn(registry, 'setStatus').mockRejectedValue('disk gone');
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    await connection.reconnectRequired();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('needs reconnecting: disk gone'));
  });

  it('keeps its record when the company has been removed from the registry meanwhile', async () => {
    const record = await store.addCompany(acme);
    const connection = store.connection(record);
    await registry.remove('sandbox', '111');
    await connection.reconnectRequired();
    expect(connection.record).toEqual(record);
  });
});
