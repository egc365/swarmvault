import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendReceiptChain, signWriteReceipt, verifyReceipt, verifyReceiptChain } from "../../src/index.js";

const tempDirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-audit-"));
  tempDirs.push(dir); return dir;
}
afterEach(async () => Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

describe("audit-chain", () => {
  it("signs and verifies write receipts", async () => {
    const receipt = await signWriteReceipt({ vaultRoot: await tmp(), pageId: "state/graph.json", contentHash: "abc", sessionId: "test" });
    expect(verifyReceipt(receipt)).toBe(true);
    expect(receipt.payload.spec).toBe("draft-farley-acta-signed-receipts-01");
  });
  it("detects tampered receipts", async () => {
    const receipt = await signWriteReceipt({ vaultRoot: await tmp(), pageId: "state/graph.json", contentHash: "abc", sessionId: "test" });
    receipt.payload.contentHash = "tampered";
    expect(verifyReceipt(receipt)).toBe(false);
  });
  it("validates sequential receipt chains", async () => {
    const vaultRoot = await tmp();
    const first = await signWriteReceipt({ vaultRoot, pageId: "state/graph.json", contentHash: "one", sessionId: "test" });
    await appendReceiptChain(vaultRoot, first);
    await appendReceiptChain(vaultRoot, await signWriteReceipt({ vaultRoot, pageId: "state/retrieval/manifest.json", contentHash: "two", sessionId: "test", prevHash: first.hash }));
    await expect(verifyReceiptChain(vaultRoot)).resolves.toEqual({ valid: true, total: 2, failures: [] });
  });
});
