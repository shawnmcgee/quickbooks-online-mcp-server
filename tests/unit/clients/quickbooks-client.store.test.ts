/**
 * QuickbooksClient backed by the company store (src/store) instead of .env.
 *
 * A store-backed client must: save every rotated refresh token to the store;
 * keep working on the new token if that save fails; pick up a token another
 * process saved after its own is rejected; and never start the interactive
 * localhost OAuth flow. A missing or dead token becomes a "reconnect this
 * company" error instead, in sandbox and production alike.
 */
import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-client-store-'));
const legacyEnvPath = path.join(tmpDir, 'legacy.env');

process.env.QUICKBOOKS_CLIENT_ID = 'test-client-id';
process.env.QUICKBOOKS_CLIENT_SECRET = 'test-client-secret';
process.env.QUICKBOOKS_ENVIRONMENT = 'sandbox';
process.env.QUICKBOOKS_TOKEN_STORE_PATH = legacyEnvPath;

jest.unstable_mockModule('dotenv', () => ({ default: { config: jest.fn(), parse: jest.fn(() => ({})) } }));

const refreshDispatch = jest.fn<(token: string) => Promise<unknown>>();
const openMock = jest.fn(async () => undefined);
jest.unstable_mockModule('intuit-oauth', () => {
  class MockOAuthClient {
    static scopes = { Accounting: 'com.intuit.quickbooks.accounting' };
    refreshUsingToken = jest.fn((token: string) => refreshDispatch(token));
    createToken = jest.fn();
    authorizeUri = jest.fn(() => 'https://appcenter.intuit.com/connect/oauth2?mock');
  }
  return { default: MockOAuthClient };
});
jest.unstable_mockModule('node-quickbooks', () => ({
  default: class MockQuickBooks {
    constructor(..._args: unknown[]) {}
  },
}));
jest.unstable_mockModule('open', () => ({ default: openMock }));
const createServer = jest.fn();
jest.unstable_mockModule('http', () => ({ default: { createServer } }));

const { QuickbooksClient } = await import('../../../src/clients/quickbooks-client');
const { CompanyRegistry } = await import('../../../src/store/company-registry');
const { CompanyStore, ReconnectRequiredError } = await import('../../../src/store/company-store');
const { CompanyClients } = await import('../../../src/store/company-clients');
const { MemorySecretStore, noWait } = await import('../../mocks/memory-secret-store');

type Store = {
  loadRefreshToken: jest.Mock<() => Promise<string | undefined>>;
  saveRefreshToken: jest.Mock<(t: string) => Promise<void>>;
  reconnectRequired: jest.Mock<(cause?: string) => Promise<Error>>;
};

function fakeStore(): Store {
  return {
    loadRefreshToken: jest.fn<() => Promise<string | undefined>>().mockResolvedValue(undefined),
    saveRefreshToken: jest.fn<(t: string) => Promise<void>>().mockResolvedValue(undefined),
    reconnectRequired: jest.fn(async (cause?: string) => new Error(`RECONNECT: ${cause}`)),
  };
}

function makeClient(store: Store, overrides: { refreshToken?: string; environment?: string } = {}) {
  return new QuickbooksClient({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: 'refreshToken' in overrides ? overrides.refreshToken : 'rt-1',
    realmId: '111',
    environment: overrides.environment ?? 'sandbox',
    redirectUri: 'http://localhost:8000/callback',
    store,
  });
}

const tokenOf = (client: unknown) => (client as { refreshToken?: string }).refreshToken;
const issued = (refresh_token?: string) => ({ token: { access_token: 'access', expires_in: 3600, refresh_token } });
const deadTokenError = () =>
  Object.assign(new Error('Request failed with status code 400'), {
    authResponse: { response: '', status: () => undefined },
  });

let logSpy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  refreshDispatch.mockReset();
  openMock.mockClear();
  createServer.mockClear();
  logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(createServer).not.toHaveBeenCalled(); // never the interactive OAuth flow
  expect(openMock).not.toHaveBeenCalled();
  expect(fs.existsSync(legacyEnvPath)).toBe(false); // never the .env token file
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('store-backed QuickbooksClient', () => {
  it('saves a rotated refresh token to the store', async () => {
    const store = fakeStore();
    const client = makeClient(store);
    refreshDispatch.mockResolvedValueOnce(issued('rt-2'));

    await client.authenticate();

    expect(refreshDispatch).toHaveBeenCalledWith('rt-1');
    expect(store.saveRefreshToken).toHaveBeenCalledWith('rt-2');
    expect(tokenOf(client)).toBe('rt-2');
    expect(logSpy).toHaveBeenCalledWith('[qbo-client] Refresh token rotated and saved to the company store');
  });

  it('does not save when Intuit returns the same refresh token', async () => {
    const store = fakeStore();
    refreshDispatch.mockResolvedValueOnce(issued('rt-1'));
    await makeClient(store).authenticate();
    expect(store.saveRefreshToken).not.toHaveBeenCalled();
  });

  it('keeps working on the new token when the save fails', async () => {
    const store = fakeStore();
    store.saveRefreshToken.mockRejectedValueOnce(new Error('EPERM'));
    const client = makeClient(store);
    refreshDispatch.mockResolvedValueOnce(issued('rt-2'));

    await expect(client.authenticate()).resolves.toBeDefined();

    expect(tokenOf(client)).toBe('rt-2');
    expect(logSpy).toHaveBeenCalledWith('[qbo-client] Failed to persist rotated refresh token:', expect.any(Error));
  });

  it("retries with the store's token after its own is rejected (another process rotated it)", async () => {
    const store = fakeStore();
    store.loadRefreshToken.mockResolvedValue('rt-from-sibling');
    refreshDispatch.mockRejectedValueOnce(deadTokenError()).mockResolvedValueOnce(issued('rt-from-sibling'));

    const client = makeClient(store, { refreshToken: 'rt-stale' });
    await client.authenticate();

    expect(refreshDispatch.mock.calls).toEqual([['rt-stale'], ['rt-from-sibling']]);
    expect(tokenOf(client)).toBe('rt-from-sibling');
    expect(store.reconnectRequired).not.toHaveBeenCalled();
  });

  it('asks for a reconnect, not a browser, when the token is dead and the store cannot help', async () => {
    const store = fakeStore();
    store.loadRefreshToken.mockRejectedValue(new Error('credential store locked'));
    refreshDispatch.mockRejectedValue(deadTokenError());

    await expect(makeClient(store).authenticate()).rejects.toThrow(
      'RECONNECT: Failed to refresh Quickbooks token: Request failed with status code 400'
    );
    expect(refreshDispatch).toHaveBeenCalledTimes(1);
  });

  it('asks for a reconnect in production too, instead of the .env re-authorisation message', async () => {
    const store = fakeStore();
    refreshDispatch.mockRejectedValue(deadTokenError());

    const err = await makeClient(store, { environment: 'production' }).authenticate().catch((e) => e);

    expect(err.message).toMatch(/^RECONNECT:/);
    expect(err.message).not.toMatch(/Production Setup/);
  });

  it('asks for a reconnect when there is no saved token at all', async () => {
    const store = fakeStore();
    await expect(makeClient(store, { refreshToken: undefined }).authenticate()).rejects.toThrow(
      'RECONNECT: no saved sign-in token'
    );
    expect(refreshDispatch).not.toHaveBeenCalled();
  });

  it('leaves the company alone on a transient failure', async () => {
    const store = fakeStore();
    refreshDispatch.mockRejectedValue(new Error('getaddrinfo ETIMEDOUT oauth.platform.intuit.com'));

    await expect(makeClient(store).authenticate()).rejects.toThrow(/ETIMEDOUT/);
    expect(store.reconnectRequired).not.toHaveBeenCalled();
    expect(store.loadRefreshToken).not.toHaveBeenCalled();
  });
});

describe('store-backed clients end to end (registry + credential store + pool)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpDir, 'store-'));
  });

  const startPool = (registryPath: string, secrets: InstanceType<typeof MemorySecretStore>) =>
    new CompanyClients({
      store: new CompanyStore(new CompanyRegistry(registryPath, noWait), secrets, noWait),
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      environment: 'sandbox',
      createClient: (config) => new QuickbooksClient(config),
    });

  it('persists rotations across a restart', async () => {
    const registryPath = path.join(dir, 'companies.json');
    const secrets = new MemorySecretStore();
    await new CompanyStore(new CompanyRegistry(registryPath), secrets).addCompany({
      name: 'Acme',
      realmId: '111',
      environment: 'sandbox',
      refreshToken: 'rt-1',
    });

    refreshDispatch.mockResolvedValueOnce(issued('rt-2'));
    const first = startPool(registryPath, secrets);
    await first.load();
    expect(await first.refreshAll()).toEqual([expect.objectContaining({ ok: true })]);
    expect(secrets.values.get('sandbox:111')).toBe('rt-2');

    // A fresh process (new pool, new store objects) starts from the rotated token.
    refreshDispatch.mockResolvedValueOnce(issued('rt-3'));
    const second = startPool(registryPath, secrets);
    await second.load();
    await second.refreshAll();
    expect(refreshDispatch.mock.calls.map((c) => c[0])).toEqual(['rt-1', 'rt-2']);
    expect(secrets.values.get('sandbox:111')).toBe('rt-3');
  });

  it('flags a company whose token is dead and leaves the other working', async () => {
    const registryPath = path.join(dir, 'companies.json');
    const secrets = new MemorySecretStore();
    const store = new CompanyStore(new CompanyRegistry(registryPath), secrets);
    await store.addCompany({ name: 'Acme', realmId: '111', environment: 'sandbox', refreshToken: 'rt-dead' });
    await store.addCompany({ name: 'Beta', realmId: '222', environment: 'sandbox', refreshToken: 'rt-beta' });
    refreshDispatch.mockImplementation(async (token) => {
      if (token === 'rt-dead') throw deadTokenError();
      return issued(token);
    });

    const clients = startPool(registryPath, secrets);
    await clients.load();
    const [acme, beta] = await clients.refreshAll();

    expect(acme).toMatchObject({ ok: false, needsReconnect: true, company: { status: 'needs_reconnect' } });
    expect(beta.ok).toBe(true);
    const saved = await new CompanyRegistry(registryPath).find('sandbox', '111');
    expect(saved?.statusDetail).toBe('Failed to refresh Quickbooks token: Request failed with status code 400');
    const err = await clients.get('111')!.client.authenticate().catch((e) => e);
    expect(err).toBeInstanceOf(ReconnectRequiredError);
  });
});
