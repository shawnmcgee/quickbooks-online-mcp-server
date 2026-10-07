import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CompanyRegistry,
  CompanyRegistryError,
  REGISTRY_FILE_NAME,
  STORE_DIR_ENV,
  defaultStoreDir,
  parseRegistry,
} from '../../../src/store/company-registry';

describe('defaultStoreDir', () => {
  it('uses %LOCALAPPDATA% on Windows', () => {
    expect(defaultStoreDir({ LOCALAPPDATA: 'C:\\Users\\acct\\AppData\\Local' }, 'win32', 'C:\\Users\\acct')).toBe(
      'C:\\Users\\acct\\AppData\\Local\\qbo-mcp'
    );
  });

  it('falls back to the profile AppData\\Local on Windows when %LOCALAPPDATA% is unset', () => {
    expect(defaultStoreDir({}, 'win32', 'C:\\Users\\acct')).toBe('C:\\Users\\acct\\AppData\\Local\\qbo-mcp');
  });

  it('uses Application Support on macOS', () => {
    expect(defaultStoreDir({}, 'darwin', '/Users/acct')).toBe('/Users/acct/Library/Application Support/qbo-mcp');
  });

  it('uses $XDG_DATA_HOME, else ~/.local/share, on Linux', () => {
    expect(defaultStoreDir({ XDG_DATA_HOME: '/data' }, 'linux', '/home/acct')).toBe('/data/qbo-mcp');
    expect(defaultStoreDir({}, 'linux', '/home/acct')).toBe('/home/acct/.local/share/qbo-mcp');
  });

  it('honours an absolute override, POSIX or Windows style', () => {
    expect(defaultStoreDir({ [STORE_DIR_ENV]: ' /srv/qbo ' }, 'linux', '/home/acct')).toBe('/srv/qbo');
    expect(defaultStoreDir({ [STORE_DIR_ENV]: 'D:\\qbo' }, 'linux', '/home/acct')).toBe('D:\\qbo');
  });

  it('rejects a relative override', () => {
    expect(() => defaultStoreDir({ [STORE_DIR_ENV]: 'relative/dir' }, 'linux', '/home/acct')).toThrow(
      /must be an absolute path/
    );
  });

  it('reads the real environment by default', () => {
    const saved = process.env[STORE_DIR_ENV];
    process.env[STORE_DIR_ENV] = '/from/env';
    try {
      expect(defaultStoreDir()).toBe('/from/env');
    } finally {
      if (saved === undefined) delete process.env[STORE_DIR_ENV];
      else process.env[STORE_DIR_ENV] = saved;
    }
  });
});

describe('parseRegistry', () => {
  const valid = {
    name: 'Acme',
    realmId: '1',
    environment: 'sandbox',
    status: 'needs_reconnect',
    statusDetail: 'token rejected',
    addedAt: 't0',
    updatedAt: 't1',
  };

  it('accepts a well-formed file', () => {
    expect(parseRegistry(JSON.stringify({ version: 1, companies: [valid] }), 'f').companies).toEqual([valid]);
  });

  it.each([
    ['invalid JSON', '{nope', /not valid JSON/],
    ['null', 'null', /unknown format/],
    ['a newer version', JSON.stringify({ version: 2, companies: [] }), /unknown format/],
    ['companies not a list', JSON.stringify({ version: 1, companies: {} }), /unknown format/],
    ['a null entry', JSON.stringify({ version: 1, companies: [valid, null] }), /Entry 2 .* malformed/],
    ['a bad environment', JSON.stringify({ version: 1, companies: [{ ...valid, environment: 'prod' }] }), /Entry 1/],
    ['a non-string detail', JSON.stringify({ version: 1, companies: [{ ...valid, statusDetail: 5 }] }), /Entry 1/],
  ])('rejects %s without repairing it', (_label, text, pattern) => {
    expect(() => parseRegistry(text, '/x/companies.json')).toThrow(CompanyRegistryError);
    expect(() => parseRegistry(text, '/x/companies.json')).toThrow(pattern);
  });
});

describe('CompanyRegistry', () => {
  let dir: string;
  let file: string;
  let clock: number;
  let registry: CompanyRegistry;
  const now = () => `2026-10-07T00:00:0${clock++}.000Z`;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-registry-'));
    file = path.join(dir, REGISTRY_FILE_NAME);
    clock = 0;
    registry = new CompanyRegistry(file, {}, now);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is empty when the file does not exist yet', async () => {
    await expect(registry.list()).resolves.toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('adds a company and persists it as readable JSON', async () => {
    const added = await registry.upsert({ name: '  Acme Ltd ', realmId: ' 123 ', environment: 'sandbox' });
    expect(added).toEqual({
      name: 'Acme Ltd',
      realmId: '123',
      environment: 'sandbox',
      status: 'connected',
      addedAt: '2026-10-07T00:00:00.000Z',
      updatedAt: '2026-10-07T00:00:00.000Z',
    });
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk).toEqual({ version: 1, companies: [added] });
    // A second instance (another server process) sees the same list.
    await expect(new CompanyRegistry(file).find('sandbox', '123')).resolves.toEqual(added);
  });

  it('treats an upsert of a known realm as a reconnect: renames, keeps addedAt, clears the status', async () => {
    await registry.upsert({ name: 'Acme', realmId: '1', environment: 'sandbox' });
    await registry.setStatus('sandbox', '1', 'needs_reconnect', 'token rejected');
    const reconnected = await registry.upsert({ name: 'Acme Holdings', realmId: '1', environment: 'sandbox' });
    expect(reconnected).toMatchObject({ name: 'Acme Holdings', status: 'connected', addedAt: '2026-10-07T00:00:00.000Z' });
    expect(reconnected.statusDetail).toBeUndefined();
    expect(await registry.list()).toHaveLength(1);
  });

  it('refuses a second company whose name differs only by case, within one environment', async () => {
    await registry.upsert({ name: 'Acme', realmId: '1', environment: 'sandbox' });
    await expect(registry.upsert({ name: 'ACME', realmId: '2', environment: 'sandbox' })).rejects.toThrow(
      /already called "Acme" \(realm 1\)/
    );
    // The same name in the other environment is a different company.
    await expect(registry.upsert({ name: 'Acme', realmId: '2', environment: 'production' })).resolves.toMatchObject({
      realmId: '2',
    });
    // The failed upsert did not block later writes.
    await expect(registry.upsert({ name: 'Beta', realmId: '3', environment: 'sandbox' })).resolves.toMatchObject({
      name: 'Beta',
    });
    expect((await registry.list()).map((c) => c.name)).toEqual(['Acme', 'Acme', 'Beta']);
  });

  it('requires a name and a realm ID', async () => {
    await expect(registry.upsert({ name: ' ', realmId: '1', environment: 'sandbox' })).rejects.toThrow(
      /name is required/
    );
    await expect(registry.upsert({ name: 'Acme', realmId: '', environment: 'sandbox' })).rejects.toThrow(
      /realm ID is required/
    );
  });

  it('records and clears a needs-reconnect status', async () => {
    await registry.upsert({ name: 'Acme', realmId: '1', environment: 'sandbox' });

    const flagged = await registry.setStatus('sandbox', '1', 'needs_reconnect', 'token rejected');
    expect(flagged).toMatchObject({ status: 'needs_reconnect', statusDetail: 'token rejected' });

    const bare = await registry.setStatus('sandbox', '1', 'needs_reconnect');
    expect(bare?.statusDetail).toBeUndefined();

    const cleared = await registry.setStatus('sandbox', '1', 'connected', 'ignored for connected');
    expect(cleared).toMatchObject({ status: 'connected' });
    expect(cleared?.statusDetail).toBeUndefined();
  });

  it('returns undefined when setting the status of an unknown company', async () => {
    await expect(registry.setStatus('sandbox', 'nope', 'connected')).resolves.toBeUndefined();
  });

  it('removes a company and reports whether it was there', async () => {
    await registry.upsert({ name: 'Acme', realmId: '1', environment: 'sandbox' });
    await registry.upsert({ name: 'Acme', realmId: '1', environment: 'production' });
    await expect(registry.remove('sandbox', '1')).resolves.toBe(true);
    await expect(registry.remove('sandbox', '1')).resolves.toBe(false);
    expect((await registry.list()).map((c) => c.environment)).toEqual(['production']);
  });

  it('serialises concurrent changes so none is lost', async () => {
    await Promise.all(
      ['1', '2', '3', '4', '5'].map((id) => registry.upsert({ name: `Co ${id}`, realmId: id, environment: 'sandbox' }))
    );
    expect((await registry.list()).map((c) => c.realmId).sort()).toEqual(['1', '2', '3', '4', '5']);
  });

  it('refuses to read or overwrite a corrupt file', async () => {
    fs.writeFileSync(file, '{ corrupt');
    await expect(registry.list()).rejects.toThrow(CompanyRegistryError);
    await expect(registry.upsert({ name: 'Acme', realmId: '1', environment: 'sandbox' })).rejects.toThrow(
      /not valid JSON/
    );
    expect(fs.readFileSync(file, 'utf8')).toBe('{ corrupt');
  });

  it('surfaces read errors other than a missing file', async () => {
    fs.mkdirSync(file); // a directory where the file should be
    await expect(registry.list()).rejects.toThrow(/EISDIR/);
  });

  it('stamps real ISO times by default', async () => {
    const real = new CompanyRegistry(file);
    const added = await real.upsert({ name: 'Acme', realmId: '1', environment: 'sandbox' });
    expect(Number.isNaN(Date.parse(added.addedAt))).toBe(false);
  });

  it('opens the registry in the default store directory', () => {
    const saved = process.env[STORE_DIR_ENV];
    process.env[STORE_DIR_ENV] = dir;
    try {
      expect(CompanyRegistry.atDefaultLocation().filePath).toBe(path.join(dir, REGISTRY_FILE_NAME));
    } finally {
      if (saved === undefined) delete process.env[STORE_DIR_ENV];
      else process.env[STORE_DIR_ENV] = saved;
    }
  });
});
