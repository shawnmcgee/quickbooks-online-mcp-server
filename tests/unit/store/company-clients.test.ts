import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CompanyClientConfig, CompanyClients } from '../../../src/store/company-clients';
import { CompanyRegistry } from '../../../src/store/company-registry';
import { CompanyStore } from '../../../src/store/company-store';
import { MemorySecretStore, noWait } from '../../mocks/memory-secret-store';

class FakeClient {
  authenticate = jest.fn<() => Promise<unknown>>().mockResolvedValue({});
  constructor(readonly config: CompanyClientConfig) {}
}

let dir: string;
let registry: CompanyRegistry;
let secrets: MemorySecretStore;
let store: CompanyStore;
let created: FakeClient[];

function pool(overrides: { redirectUri?: string; environment?: 'sandbox' | 'production' } = {}) {
  return new CompanyClients<FakeClient>({
    store,
    clientId: 'cid',
    clientSecret: 'secret',
    environment: overrides.environment ?? 'sandbox',
    redirectUri: overrides.redirectUri,
    createClient: (config) => {
      const client = new FakeClient(config);
      created.push(client);
      return client;
    },
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-clients-'));
  registry = new CompanyRegistry(path.join(dir, 'companies.json'), noWait);
  secrets = new MemorySecretStore();
  store = new CompanyStore(registry, secrets, noWait);
  created = [];
  await store.addCompany({ name: 'Acme', realmId: '111', environment: 'sandbox', refreshToken: 'rt-acme' });
  await store.addCompany({ name: 'Beta', realmId: '222', environment: 'sandbox', refreshToken: 'rt-beta' });
  await store.addCompany({ name: 'Live Co', realmId: '333', environment: 'production', refreshToken: 'rt-live' });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('CompanyClients.load', () => {
  it('builds one store-backed client per company in the configured environment', async () => {
    const clients = pool();
    const loaded = await clients.load();

    expect(loaded.map((c) => c.record.name)).toEqual(['Acme', 'Beta']); // production company skipped
    expect(created.map((c) => c.config)).toEqual([
      {
        clientId: 'cid',
        clientSecret: 'secret',
        refreshToken: 'rt-acme',
        realmId: '111',
        environment: 'sandbox',
        redirectUri: 'http://localhost:8000/callback',
        store: store.connection(loaded[0].record),
      },
      expect.objectContaining({ realmId: '222', refreshToken: 'rt-beta' }),
    ]);
    expect(clients.get('111')?.client).toBe(created[0]);
    expect(clients.get('333')).toBeUndefined();
  });

  it('passes a configured redirect URI through and loads only production companies for production keys', async () => {
    await pool({ redirectUri: 'https://example.test/cb', environment: 'production' }).load();
    expect(created.map((c) => [c.config.realmId, c.config.redirectUri])).toEqual([['333', 'https://example.test/cb']]);
  });

  it('keeps existing clients on reload, picks up renames and additions, and drops removed companies', async () => {
    const clients = pool();
    await clients.load();
    const acmeClient = clients.get('111')?.client;

    await store.addCompany({ name: 'Acme Ltd', realmId: '111', environment: 'sandbox', refreshToken: 'rt-new' });
    await store.addCompany({ name: 'Gamma', realmId: '444', environment: 'sandbox', refreshToken: 'rt-g' });
    await store.removeCompany('sandbox', '222');
    const reloaded = await clients.load();

    expect(reloaded.map((c) => c.record.name)).toEqual(['Acme Ltd', 'Gamma']);
    expect(clients.get('111')?.client).toBe(acmeClient);
    expect(clients.get('111')?.connection.record.name).toBe('Acme Ltd');
    expect(clients.get('222')).toBeUndefined();
    expect(created).toHaveLength(3);
  });

  it('rejects when the credential store cannot be read', async () => {
    secrets.getError = new Error('credential store unavailable');
    await expect(pool().load()).rejects.toThrow('credential store unavailable');
  });
});

describe('CompanyClients.refreshAll', () => {
  it('refreshes every company in parallel and reports success', async () => {
    const clients = pool();
    await clients.load();
    const outcomes = await clients.refreshAll();
    expect(outcomes.map((o) => [o.company.name, o.ok])).toEqual([
      ['Acme', true],
      ['Beta', true],
    ]);
    expect(created.every((c) => c.authenticate.mock.calls.length === 1)).toBe(true);
  });

  it('flags a company whose token is dead, without affecting the others', async () => {
    const clients = pool();
    await clients.load();
    const acme = clients.get('111')!;
    acme.client.authenticate.mockImplementation(async () => {
      throw await acme.connection.reconnectRequired('Request failed with status code 400');
    });

    const [acmeOutcome, betaOutcome] = await clients.refreshAll();

    expect(acmeOutcome).toMatchObject({
      ok: false,
      needsReconnect: true,
      company: { name: 'Acme', status: 'needs_reconnect', statusDetail: 'Request failed with status code 400' },
    });
    expect(acmeOutcome.ok === false && acmeOutcome.error).toContain('"Acme" (sandbox, realm 111) needs to be reconnected');
    expect(betaOutcome.ok).toBe(true);
    expect(clients.get('111')?.record.status).toBe('needs_reconnect');
  });

  it('reports a transient failure without changing the status', async () => {
    const clients = pool();
    await clients.load();
    clients.get('111')!.client.authenticate.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    clients.get('222')!.client.authenticate.mockRejectedValue('socket hang up');

    const outcomes = await clients.refreshAll();

    expect(outcomes).toEqual([
      expect.objectContaining({ ok: false, needsReconnect: false, error: 'getaddrinfo ENOTFOUND' }),
      expect.objectContaining({ ok: false, needsReconnect: false, error: 'socket hang up' }),
    ]);
    expect((await registry.list()).every((c) => c.status === 'connected')).toBe(true);
  });

  it('marks a previously flagged company connected again once it refreshes', async () => {
    await registry.setStatus('sandbox', '111', 'needs_reconnect', 'old failure');
    const clients = pool();
    await clients.load();

    const [acme] = await clients.refreshAll();

    expect(acme).toMatchObject({ ok: true, company: { status: 'connected' } });
    expect((await registry.find('sandbox', '111'))?.status).toBe('connected');
    expect(clients.get('111')?.connection.record.status).toBe('connected');
  });

  it('still reports success when the status update cannot be written', async () => {
    await registry.setStatus('sandbox', '111', 'needs_reconnect');
    const clients = pool();
    await clients.load();
    jest.spyOn(registry, 'setStatus').mockRejectedValueOnce(new Error('disk full')).mockRejectedValueOnce('locked');
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(clients.refreshAll()).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(log).toHaveBeenCalledWith('[qbo-store] Could not mark "Acme" connected: disk full');
  });

  it('keeps the loaded record if the company was removed before the status update', async () => {
    await registry.setStatus('sandbox', '111', 'needs_reconnect');
    const clients = pool();
    await clients.load();
    await registry.remove('sandbox', '111');

    const [acme] = await clients.refreshAll();

    expect(acme).toMatchObject({ ok: true, company: { name: 'Acme', status: 'needs_reconnect' } });
  });
});
