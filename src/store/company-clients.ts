import { CompanyRecord, QboEnvironment } from "./company-registry.js";
import { CompanyConnection, CompanyStore, ConnectionStore, ReconnectRequiredError } from "./company-store.js";

/** Constructor config for one company's client; matches QuickbooksClient's. */
export interface CompanyClientConfig {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  realmId: string;
  environment: QboEnvironment;
  redirectUri: string;
  store: ConnectionStore;
}

export interface Authenticating {
  authenticate(): Promise<unknown>;
}

export interface CompanyClientsOptions<C extends Authenticating> {
  store: CompanyStore;
  clientId: string;
  clientSecret: string;
  /** The environment these app keys belong to; companies in the other one are not loaded. */
  environment: QboEnvironment;
  /** Builds a client, normally `(config) => new QuickbooksClient(config)`. */
  createClient: (config: CompanyClientConfig) => C;
  /** Required by the OAuth client but unused for refreshes. */
  redirectUri?: string;
}

export interface ConnectedCompany<C> {
  record: CompanyRecord;
  connection: CompanyConnection;
  client: C;
}

export type RefreshOutcome =
  | { company: CompanyRecord; ok: true }
  | { company: CompanyRecord; ok: false; needsReconnect: boolean; error: string };

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One client per connected company, each saving its own rotated tokens to the store. */
export class CompanyClients<C extends Authenticating> {
  private entries = new Map<string, ConnectedCompany<C>>();

  constructor(private readonly options: CompanyClientsOptions<C>) {}

  /**
   * (Re)load the company list. A company that is already loaded keeps its
   * client, so its access token and any pending save survive. Companies
   * registered under the other environment are skipped: these app keys
   * cannot refresh their tokens. Rejects if the credential store is unusable.
   */
  async load(): Promise<ConnectedCompany<C>[]> {
    const { store, environment } = this.options;
    const records = (await store.registry.list()).filter((c) => c.environment === environment);
    const next = new Map<string, ConnectedCompany<C>>();
    for (const record of records) {
      const existing = this.entries.get(record.realmId);
      if (existing) {
        existing.record = record;
        existing.connection.setCompany(record);
        next.set(record.realmId, existing);
        continue;
      }
      const connection = store.connection(record);
      const client = this.options.createClient({
        clientId: this.options.clientId,
        clientSecret: this.options.clientSecret,
        refreshToken: await connection.loadRefreshToken(),
        realmId: record.realmId,
        environment: record.environment,
        redirectUri: this.options.redirectUri ?? "http://localhost:8000/callback",
        store: connection,
      });
      next.set(record.realmId, { record, connection, client });
    }
    this.entries = next;
    return this.list();
  }

  get(realmId: string): ConnectedCompany<C> | undefined {
    return this.entries.get(realmId);
  }

  list(): ConnectedCompany<C>[] {
    return [...this.entries.values()];
  }

  /**
   * Refresh every loaded company in parallel. Run at startup, so each
   * company's refresh token is rotated and saved even when it is rarely used,
   * and a dead token is flagged before anyone asks for that company. A
   * transient failure (network, Intuit 5xx) leaves the status untouched.
   */
  async refreshAll(): Promise<RefreshOutcome[]> {
    return Promise.all(this.list().map((entry) => this.refreshOne(entry)));
  }

  private async refreshOne(entry: ConnectedCompany<C>): Promise<RefreshOutcome> {
    try {
      await entry.client.authenticate();
    } catch (err) {
      const needsReconnect = err instanceof ReconnectRequiredError;
      if (needsReconnect) entry.record = entry.connection.record;
      return { company: entry.record, ok: false, needsReconnect, error: messageOf(err) };
    }
    if (entry.record.status !== "connected") {
      try {
        const { environment, realmId } = entry.record;
        const updated = await this.options.store.registry.setStatus(environment, realmId, "connected");
        if (updated) {
          entry.record = updated;
          entry.connection.setCompany(updated);
        }
      } catch (err) {
        console.error(`[qbo-store] Could not mark "${entry.record.name}" connected: ${messageOf(err)}`);
      }
    }
    return { company: entry.record, ok: true };
  }
}
