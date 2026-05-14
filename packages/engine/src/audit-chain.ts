import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withWriteLock } from "./locks.js";
import { ensureDir, fileExists, sha256, slugify } from "./utils.js";

// Ported from scopeblind/scopeblind-gateway signed receipt primitives (MIT);
// see LICENSE-PORTS.md for source files and draft attribution.
export type SignedReceipt = {
  payload: { type: "swarmvault.write"; timestamp: string; issuer: string; agentKey: string; pageId: string; contentHash: string; sessionId: string; spec: "draft-farley-acta-signed-receipts-01"; issuer_certification: "self-signed"; prevHash: string | null };
  signature: { alg: "EdDSA"; kid: string; sig: string };
  publicKey: string;
  hash: string;
};
type Input = { pageId: string; contentHash: string; sessionId: string; timestamp?: string; prevHash?: string | null; vaultRoot?: string };
const AUDIT_SESSION = process.env.SWARMVAULT_SESSION_ID?.trim() || `pid-${process.pid}`;
const agentKey = () => slugify(process.env.SWARMVAULT_AGENT_KEY?.trim() || "default");
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
const auditDir = (root: string) => path.join(root, "state", "audit");
const chainPath = (root: string) => path.join(auditDir(root), "chain.jsonl");
function keyPaths(root: string): { pub: string; priv: string } {
  const dir = path.join(auditDir(root), "keys");
  return { pub: path.join(dir, `agent-${agentKey()}.pub`), priv: path.join(dir, `agent-${agentKey()}.priv`) };
}
async function loadOrCreateKeys(root: string): Promise<{ privateKey: string; publicKey: string; kid: string }> {
  const keys = keyPaths(root);
  if ((await fileExists(keys.pub)) && (await fileExists(keys.priv))) {
    const [publicKey, privateKey] = await Promise.all([fs.readFile(keys.pub, "utf8"), fs.readFile(keys.priv, "utf8")]);
    return { publicKey, privateKey, kid: sha256(publicKey).slice(0, 12) };
  }
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await ensureDir(path.dirname(keys.pub));
  await Promise.all([fs.writeFile(keys.pub, publicKey, "utf8"), fs.writeFile(keys.priv, privateKey, { encoding: "utf8", mode: 0o600 })]);
  return { publicKey, privateKey, kid: sha256(publicKey).slice(0, 12) };
}
function vaultRootFromStatePath(filePath: string): string {
  const parts = path.resolve(filePath).split(path.sep), stateIndex = parts.lastIndexOf("state");
  return stateIndex >= 0 ? parts.slice(0, stateIndex).join(path.sep) : path.dirname(filePath);
}
async function lastHash(filePath: string): Promise<string | null> {
  const line = (await fs.readFile(filePath, "utf8").catch(() => "")).trim().split(/\r?\n/).filter(Boolean).at(-1);
  return line ? (JSON.parse(line) as SignedReceipt).hash : null;
}
export async function signWriteReceipt(input: Input): Promise<SignedReceipt> {
  const root = input.vaultRoot ?? process.cwd(), keys = await loadOrCreateKeys(root);
  const payload: SignedReceipt["payload"] = { type: "swarmvault.write", timestamp: input.timestamp ?? new Date().toISOString(), issuer: keys.kid, agentKey: agentKey(), pageId: input.pageId, contentHash: input.contentHash, sessionId: input.sessionId, spec: "draft-farley-acta-signed-receipts-01", issuer_certification: "self-signed", prevHash: input.prevHash ?? null };
  const sig = crypto.sign(null, Buffer.from(canonicalize(payload)), crypto.createPrivateKey(keys.privateKey)).toString("hex");
  const receipt = { payload, signature: { alg: "EdDSA" as const, kid: keys.kid, sig }, publicKey: keys.publicKey, hash: "" };
  receipt.hash = sha256(canonicalize({ payload: receipt.payload, signature: receipt.signature, publicKey: receipt.publicKey }));
  return receipt;
}
export function verifyReceipt(receipt: SignedReceipt, publicKey?: string): boolean {
  try {
    const ok = crypto.verify(null, Buffer.from(canonicalize(receipt.payload)), crypto.createPublicKey(publicKey ?? receipt.publicKey), Buffer.from(receipt.signature.sig, "hex"));
    return ok && receipt.signature.alg === "EdDSA" && sha256(canonicalize({ payload: receipt.payload, signature: receipt.signature, publicKey: receipt.publicKey })) === receipt.hash;
  } catch { return false; }
}
export async function appendReceiptChain(vaultRoot: string, receipt: SignedReceipt): Promise<void> {
  await withWriteLock(chainPath(vaultRoot), async () => {
    const prevHash = await lastHash(chainPath(vaultRoot));
    const next = receipt.payload.prevHash === prevHash ? receipt : await signWriteReceipt({ ...receipt.payload, vaultRoot, prevHash });
    await fs.appendFile(chainPath(vaultRoot), `${JSON.stringify(next)}\n`, "utf8");
  });
}
export async function recordStateWrite(filePath: string): Promise<void> {
  const resolved = path.resolve(filePath);
  if (!resolved.includes(`${path.sep}state${path.sep}`) || resolved.includes(`${path.sep}state${path.sep}audit${path.sep}`)) return;
  const root = vaultRootFromStatePath(resolved), relative = resolved.slice(root.length + 1).split(path.sep).join("/");
  if (!["state/graph.json", "state/retrieval/manifest.json"].includes(relative) && !relative.startsWith("state/approvals/")) return;
  const content = await fs.readFile(resolved).catch(() => null);
  if (content) await appendReceiptChain(root, await signWriteReceipt({ vaultRoot: root, pageId: relative, contentHash: sha256(content), sessionId: AUDIT_SESSION }));
}
export async function verifyReceiptChain(vaultRoot: string): Promise<{ valid: boolean; total: number; failures: string[] }> {
  const lines = (await fs.readFile(chainPath(vaultRoot), "utf8").catch(() => "")).trim().split(/\r?\n/).filter(Boolean);
  let prev: string | null = null; const failures: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const receipt = JSON.parse(lines[i]) as SignedReceipt;
    if (!verifyReceipt(receipt) || receipt.payload.prevHash !== prev) failures.push(`entry ${i + 1}`);
    prev = receipt.hash;
  }
  return { valid: failures.length === 0, total: lines.length, failures };
}
export async function showReceiptChain(vaultRoot: string, pageId: string): Promise<SignedReceipt[]> {
  return (await fs.readFile(chainPath(vaultRoot), "utf8").catch(() => "")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as SignedReceipt).filter((receipt) => receipt.payload.pageId === pageId);
}
