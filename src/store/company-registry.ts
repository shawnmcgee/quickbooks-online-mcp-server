import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { AtomicWriteOptions, writeFileAtomic } from "./atomic-file.js";

/**
 * The list of connected companies. Nothing in it is secret: refresh tokens
 * live in the OS credential store (see secret-store.ts), keyed by environment
 * and realm ID. The file sits in the user's local app-data directory, outside
 * the extension's install directory, so extension updates and reinstalls do
 * not touch it.
 */

export type QboEnvironment = "sandbox" | "production";
export type CompanyStatus = "connected" | "needs_reconnect";

export interface CompanyRecord {
  name: string;
  realmId: string;
  environment: QboEnvironment;
  status: CompanyStatus;
  /** Why the company needs reconnecting. Never contains a token. */
  statusDetail?: string;
  addedAt: string;
  updatedAt: string;
}

interface RegistryFile {
  version: 1;
  companies: CompanyRecord[];
}

export const STORE_DIR_ENV = "QUICKBOOKS_STORE_DIR";
export const REGISTRY_FILE_NAME = "companies.json";
const APP_DIR_NAME = "qbo-mcp";

/**
 * Directory holding the registry. QUICKBOOKS_STORE_DIR (absolute) overrides it;
 * otherwise %LOCALAPPDATA%\qbo-mcp on Windows (Local rather than Roaming, so it
 * is never copied to a domain profile server), ~/Library/Application Support
 * on macOS, and $XDG_DATA_HOME or ~/.local/share elsewhere.
 */
export function defaultStoreDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir()
): string {
  const override = env[STORE_DIR_ENV]?.trim();
  if (override) {
    if (!path.isAbsolute(override) && !path.win32.isAbsolute(override)) {
      throw new Error(`${STORE_DIR_ENV} must be an absolute path, got "${override}"`);
    }
    return override;
  }
  if (platform === "win32") {
    return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), APP_DIR_NAME);
  }
  if (platform === "darwin") {
    return path.posix.join(home, "Library", "Application Support", APP_DIR_NAME);
  }
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, ".local", "share"), APP_DIR_NAME);
}

export class CompanyRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyRegistryError";
  }
}

const ENVIRONMENTS: readonly string[] = ["sandbox", "production"];
const STATUSES: readonly string[] = ["connected", "needs_reconnect"];

function isCompanyRecord(value: unknown): value is CompanyRecord {
  const c = value as Record<string, unknown> | null;
  return (
    typeof c === "object" &&
    c !== null &&
    typeof c.name === "string" &&
    typeof c.realmId === "string" &&
    ENVIRONMENTS.includes(c.environment as string) &&
    STATUSES.includes(c.status as string) &&
    (c.statusDetail === undefined || typeof c.statusDetail === "string") &&
    typeof c.addedAt === "string" &&
    typeof c.updatedAt === "string"
  );
}

/** Parse and validate the registry file. Never repairs: a bad file is reported, not overwritten. */
export function parseRegistry(text: string, filePath: string): RegistryFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new CompanyRegistryError(
      `The company list at ${filePath} is not valid JSON (${(err as Error).message}). It was left untouched.`
    );
  }
  const file = data as Partial<RegistryFile> | null;
  if (typeof file !== "object" || file === null || file.version !== 1 || !Array.isArray(file.companies)) {
    throw new CompanyRegistryError(
      `The company list at ${filePath} has an unknown format (expected version 1). It was left untouched.`
    );
  }
  const bad = file.companies.findIndex((c) => !isCompanyRecord(c));
  if (bad !== -1) {
    throw new CompanyRegistryError(
      `Entry ${bad + 1} in the company list at ${filePath} is malformed. It was left untouched.`
    );
  }
  return { version: 1, companies: file.companies };
}

const sameCompany = (environment: QboEnvironment, realmId: string) => (c: CompanyRecord) =>
  c.environment === environment && c.realmId === realmId;

export class CompanyRegistry {
  // Serialises read-modify-write cycles within this process. Writes are rare
  // (connect, remove, status change); two server processes changing the list
  // at the same instant can still race, which at worst drops an entry whose
  // token is still in the credential store, fixed by reconnecting it.
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly writeOptions: AtomicWriteOptions = {},
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  static atDefaultLocation(): CompanyRegistry {
    return new CompanyRegistry(path.join(defaultStoreDir(), REGISTRY_FILE_NAME));
  }

  /** All registered companies, read fresh from disk (another process may have changed the list). */
  async list(): Promise<CompanyRecord[]> {
    return (await this.read()).companies;
  }

  async find(environment: QboEnvironment, realmId: string): Promise<CompanyRecord | undefined> {
    return (await this.list()).find(sameCompany(environment, realmId));
  }

  /**
   * Register a company, or rename and mark connected one that is already
   * registered (a reconnect). Names must be unique within an environment,
   * ignoring case, so two entries can never differ only by capitalisation.
   */
  async upsert(input: { name: string; realmId: string; environment: QboEnvironment }): Promise<CompanyRecord> {
    const name = input.name.trim();
    const realmId = input.realmId.trim();
    if (!name) throw new CompanyRegistryError("A company name is required.");
    if (!realmId) throw new CompanyRegistryError("A realm ID is required.");
    return this.mutate((file) => {
      const clash = file.companies.find(
        (c) =>
          c.environment === input.environment &&
          c.realmId !== realmId &&
          c.name.toLowerCase() === name.toLowerCase()
      );
      if (clash) {
        throw new CompanyRegistryError(
          `Another ${input.environment} company is already called "${clash.name}" (realm ${clash.realmId}). Choose a different name.`
        );
      }
      const now = this.now();
      const index = file.companies.findIndex(sameCompany(input.environment, realmId));
      const record: CompanyRecord = {
        name,
        realmId,
        environment: input.environment,
        status: "connected",
        addedAt: index === -1 ? now : file.companies[index].addedAt,
        updatedAt: now,
      };
      if (index === -1) file.companies.push(record);
      else file.companies[index] = record;
      return record;
    });
  }

  /** Update a company's status. Returns the updated record, or undefined if it is not registered. */
  setStatus(
    environment: QboEnvironment,
    realmId: string,
    status: CompanyStatus,
    detail?: string
  ): Promise<CompanyRecord | undefined> {
    return this.mutate((file) => {
      const record = file.companies.find(sameCompany(environment, realmId));
      if (!record) return undefined;
      record.status = status;
      if (status === "needs_reconnect" && detail) record.statusDetail = detail;
      else delete record.statusDetail;
      record.updatedAt = this.now();
      return record;
    });
  }

  /** Remove a company. Returns false if it was not registered. */
  remove(environment: QboEnvironment, realmId: string): Promise<boolean> {
    return this.mutate((file) => {
      const before = file.companies.length;
      file.companies = file.companies.filter((c) => !sameCompany(environment, realmId)(c));
      return file.companies.length !== before;
    });
  }

  private mutate<T>(change: (file: RegistryFile) => T): Promise<T> {
    const run = this.writeChain.then(async () => {
      const file = await this.read();
      const result = change(file);
      await writeFileAtomic(this.filePath, `${JSON.stringify(file, null, 2)}\n`, this.writeOptions);
      return result;
    });
    this.writeChain = run.catch(() => {});
    return run;
  }

  private async read(): Promise<RegistryFile> {
    let text: string;
    try {
      text = await fsp.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, companies: [] };
      throw err;
    }
    return parseRegistry(text, this.filePath);
  }
}
