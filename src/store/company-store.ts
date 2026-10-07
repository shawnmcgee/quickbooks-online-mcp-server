import { RetryOptions, withRetry } from "./atomic-file.js";
import { CompanyRecord, CompanyRegistry, QboEnvironment } from "./company-registry.js";
import { SecretStore } from "./secret-store.js";

/**
 * What a QuickbooksClient needs from the store for its own company. When a
 * client is given one, it reads and writes its refresh token here instead of
 * .env, and a missing or rejected token ends in reconnectRequired() instead
 * of the interactive localhost OAuth flow.
 */
export interface ConnectionStore {
  /** The refresh token currently saved for this company. */
  loadRefreshToken(): Promise<string | undefined>;
  /** Save a rotated refresh token. Rejects if it could not be saved. */
  saveRefreshToken(refreshToken: string): Promise<void>;
  /** Record that the company must be reconnected; resolves to the error to throw. */
  reconnectRequired(cause?: string): Promise<Error>;
}

export class ReconnectRequiredError extends Error {
  constructor(
    readonly company: Pick<CompanyRecord, "name" | "realmId" | "environment">,
    readonly detail?: string
  ) {
    super(
      `"${company.name}" (${company.environment}, realm ${company.realmId}) needs to be reconnected to QuickBooks` +
        `${detail ? ` (${detail})` : ""}. Reconnect this company, then try again.`
    );
    this.name = "ReconnectRequiredError";
  }
}

/** Credential-store key for a company's refresh token. */
export const secretKey = (environment: QboEnvironment, realmId: string) => `${environment}:${realmId}`;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The company list plus each company's refresh token. The token is treated as
 * invalid the moment Intuit rotates it, so a rotated token that cannot be
 * saved is retried and reported rather than dropped.
 */
export class CompanyStore {
  private readonly connections = new Map<string, CompanyConnection>();

  constructor(
    readonly registry: CompanyRegistry,
    readonly secrets: SecretStore,
    private readonly retry: RetryOptions = {}
  ) {}

  /**
   * Save a newly authorised company, or a reconnected one. The token is
   * written before the registry entry, so a crash in between leaves at most
   * an orphan credential, never a listed company without a token.
   */
  async addCompany(input: {
    name: string;
    realmId: string;
    environment: QboEnvironment;
    refreshToken: string;
  }): Promise<CompanyRecord> {
    const key = secretKey(input.environment, input.realmId);
    await withRetry(() => this.secrets.set(key, input.refreshToken), this.retry);
    // A fresh authorisation supersedes any rotated token still waiting to be saved.
    this.connections.get(key)?.discardPending();
    const record = await this.registry.upsert(input);
    this.connections.get(key)?.setCompany(record);
    return record;
  }

  /**
   * Remove a company: the registry entry first, then its token (the reverse
   * of addCompany, for the same reason). Returns false if it was not listed.
   */
  async removeCompany(environment: QboEnvironment, realmId: string): Promise<boolean> {
    const key = secretKey(environment, realmId);
    const removed = await this.registry.remove(environment, realmId);
    await withRetry(() => this.secrets.delete(key), this.retry);
    this.connections.delete(key);
    return removed;
  }

  /** The connection for a registered company; one instance per company, so a pending save is shared. */
  connection(company: CompanyRecord): CompanyConnection {
    const key = secretKey(company.environment, company.realmId);
    let connection = this.connections.get(key);
    if (!connection) {
      connection = new CompanyConnection(company, this.registry, this.secrets, this.retry);
      this.connections.set(key, connection);
    } else {
      connection.setCompany(company);
    }
    return connection;
  }
}

export class CompanyConnection implements ConnectionStore {
  private pendingToken?: string;
  private lastSaveError?: string;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    private company: CompanyRecord,
    private readonly registry: CompanyRegistry,
    private readonly secrets: SecretStore,
    private readonly retry: RetryOptions
  ) {}

  get record(): CompanyRecord {
    return this.company;
  }

  setCompany(company: CompanyRecord): void {
    this.company = company;
  }

  private get key(): string {
    return secretKey(this.company.environment, this.company.realmId);
  }

  loadRefreshToken(): Promise<string | undefined> {
    return this.secrets.get(this.key);
  }

  /**
   * Save a rotated token, retrying with backoff. If every attempt fails, the
   * token stays in memory, saveWarning describes the problem, and the next
   * flushPendingSave() tries again. Rejects on failure so the client logs it.
   */
  saveRefreshToken(refreshToken: string): Promise<void> {
    this.pendingToken = refreshToken;
    return this.flush();
  }

  /** Try again to save a token whose earlier save failed. Never rejects. */
  async flushPendingSave(): Promise<void> {
    if (this.pendingToken) await this.flush().catch(() => {});
  }

  /** Text to show in a tool result while a rotated token remains unsaved. */
  get saveWarning(): string | undefined {
    if (!this.lastSaveError) return undefined;
    const name = this.company.name;
    return (
      `WARNING: QuickBooks issued a new sign-in token for "${name}", but it could not be saved ` +
      `(${this.lastSaveError}). It is held in memory and saving will be retried. If Claude or the ` +
      `computer restarts before it is saved, "${name}" will need to be reconnected.`
    );
  }

  discardPending(): void {
    this.pendingToken = undefined;
    this.lastSaveError = undefined;
  }

  async reconnectRequired(cause?: string): Promise<Error> {
    const { environment, realmId, name } = this.company;
    try {
      const updated = await this.registry.setStatus(environment, realmId, "needs_reconnect", cause);
      if (updated) this.company = updated;
    } catch (err) {
      console.error(`[qbo-store] Could not record that "${name}" needs reconnecting: ${messageOf(err)}`);
    }
    return new ReconnectRequiredError(this.company, cause);
  }

  // Saves run one at a time and always write the newest pending token, so a
  // slow save of an older token can never land after a newer one.
  private flush(): Promise<void> {
    const run = this.saveChain.then(async () => {
      const token = this.pendingToken;
      if (!token) return;
      try {
        await withRetry(() => this.secrets.set(this.key, token), this.retry);
      } catch (err) {
        this.lastSaveError = messageOf(err);
        throw err;
      }
      if (this.pendingToken === token) {
        this.pendingToken = undefined;
        this.lastSaveError = undefined;
      }
    });
    this.saveChain = run.catch(() => {});
    return run;
  }
}
