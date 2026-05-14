import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { ensureDir, readJsonFile, slugify } from "./utils.js";

const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 5;
const LOCK_RETRY_WAIT_MS = 200;

type LockHolder = {
  pid: number;
  hostname: string;
  startedAt: string;
  agentKey: string;
  filePath?: string;
};

export class SwarmVaultLockError extends Error {
  constructor(
    message: string,
    readonly filePath: string,
    readonly lockPath: string
  ) {
    super(message);
    this.name = "SwarmVaultLockError";
  }
}

function agentKey(): string {
  return slugify(process.env.SWARMVAULT_AGENT_KEY?.trim() || "default");
}

function stateDirFor(filePath: string): string {
  const resolved = path.resolve(filePath);
  const parts = resolved.split(path.sep);
  const stateIndex = parts.indexOf("state");
  if (stateIndex >= 0) {
    return parts.slice(0, stateIndex + 1).join(path.sep);
  }
  return path.dirname(resolved);
}

async function writeAgentIdentity(filePath: string): Promise<LockHolder> {
  const holder: LockHolder = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    agentKey: agentKey()
  };
  const identityPath = path.join(stateDirFor(filePath), "agents", holder.agentKey, "identity.json");
  await ensureDir(path.dirname(identityPath));
  await fs.writeFile(identityPath, `${JSON.stringify(holder, null, 2)}\n`, "utf8");
  return holder;
}

async function readLockHolder(lockPath: string): Promise<string | null> {
  const holderJson = await readJsonFile<LockHolder>(path.join(lockPath, "holder.json")).catch(() => null);
  if (holderJson) {
    return `${holderJson.agentKey} pid=${holderJson.pid} host=${holderJson.hostname} startedAt=${holderJson.startedAt}`;
  }

  const raw = await fs.readFile(lockPath, "utf8").catch(() => null);
  return raw?.trim() || null;
}

async function writeLockHolder(lockPath: string, holder: LockHolder, filePath: string): Promise<void> {
  await fs
    .writeFile(path.join(lockPath, "holder.json"), `${JSON.stringify({ ...holder, filePath }, null, 2)}\n`, "utf8")
    .catch(() => undefined);
}

export async function withWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(filePath);
  const lockPath = `${resolved}.lock`;
  await ensureDir(path.dirname(resolved));
  const holder = await writeAgentIdentity(resolved);
  let release: (() => Promise<void>) | null = null;

  try {
    release = await lockfile.lock(resolved, {
      stale: LOCK_STALE_MS,
      retries: {
        retries: LOCK_RETRIES,
        minTimeout: LOCK_RETRY_WAIT_MS,
        factor: 2
      },
      realpath: false,
      lockfilePath: lockPath
    });
    await writeLockHolder(lockPath, holder, resolved);
  } catch {
    const lockHolder = await readLockHolder(lockPath);
    const heldBy = lockHolder ? ` Lock appears to be held by ${lockHolder}.` : " Lock holder metadata was unavailable.";
    throw new SwarmVaultLockError(`Timed out waiting for write lock on ${resolved}.${heldBy}`, resolved, lockPath);
  }

  try {
    const result = await fn();
    const { recordStateWrite } = await import("./audit-chain.js");
    await recordStateWrite(resolved);
    return result;
  } finally {
    await fs.rm(path.join(lockPath, "holder.json"), { force: true }).catch(() => undefined);
    await release();
  }
}

export async function withReadLock<T>(_filePath: string, fn: () => Promise<T>): Promise<T> {
  // proper-lockfile provides exclusive lock directories, not shared POSIX-style
  // read locks for regular files. Reads stay unlocked until a later sprint needs
  // real reader coordination.
  return await fn();
}
