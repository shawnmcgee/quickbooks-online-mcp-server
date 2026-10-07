/**
 * Where refresh tokens live: one secret per connected company, keyed by
 * `<environment>:<realmId>` (see secretKey in company-store.ts).
 *
 * The real backend is the OS credential store through @napi-rs/keyring:
 * Windows Credential Manager (encrypted at rest with the user's Windows
 * login), the macOS Keychain, or the Secret Service on Linux. There is
 * deliberately no plaintext fallback. If the credential store cannot be used,
 * every operation fails with SecretStoreUnavailableError and says why.
 */
export interface SecretStore {
  /** The stored secret, or undefined if there is none. */
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  /** Remove the secret; succeeds if it was already absent. */
  delete(key: string): Promise<void>;
}

/** Service name the credentials are filed under (visible in Credential Manager). */
export const KEYRING_SERVICE = "qbo-mcp";

export class SecretStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretStoreUnavailableError";
  }
}

type KeyringModule = typeof import("@napi-rs/keyring");

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class KeyringSecretStore implements SecretStore {
  private module?: Promise<KeyringModule>;

  constructor(
    private readonly service: string = KEYRING_SERVICE,
    // Loaded lazily so that importing this module never needs the native
    // binary; only a store that is actually used does.
    private readonly loadModule: () => Promise<KeyringModule> = () => import("@napi-rs/keyring")
  ) {}

  async get(key: string): Promise<string | undefined> {
    return (await (await this.entry(key)).getPassword()) ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await (await this.entry(key)).setPassword(value);
  }

  async delete(key: string): Promise<void> {
    // Resolves false when there was nothing to delete; rejects on a real failure.
    await (await this.entry(key)).deleteCredential();
  }

  private async entry(key: string) {
    let keyring: KeyringModule;
    try {
      keyring = await (this.module ??= this.loadModule());
    } catch (err) {
      this.module = undefined; // let a later call try again
      throw new SecretStoreUnavailableError(`The OS credential store could not be loaded: ${messageOf(err)}`);
    }
    try {
      // On Linux, require the Secret Service. Without this the library falls
      // back silently to the kernel keyring, which loses every credential on
      // reboot. The option is ignored on Windows and macOS.
      return new keyring.AsyncEntry(this.service, key, { linux: { store: "secret-service" } });
    } catch (err) {
      throw new SecretStoreUnavailableError(`The OS credential store is unavailable: ${messageOf(err)}`);
    }
  }
}
