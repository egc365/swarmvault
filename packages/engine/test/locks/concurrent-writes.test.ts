import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { SwarmVaultLockError, withWriteLock } from "../../src/index.js";

const tempDirs: string[] = [];

async function createTempStateFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-locks-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "state", "graph.json");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "{}\n", "utf8");
  return filePath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("withWriteLock", () => {
  it("acquires, runs, and releases a single-agent write lock", async () => {
    const filePath = await createTempStateFile();

    const result = await withWriteLock(filePath, async () => {
      await fs.writeFile(filePath, '{"ok":true}\n', "utf8");
      return "written";
    });

    expect(result).toBe("written");
    await expect(fs.stat(`${filePath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes two concurrent writers for the same file", async () => {
    const filePath = await createTempStateFile();
    const spans: Array<{ writer: string; start: number; end: number }> = [];
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const first = withWriteLock(filePath, async () => {
      const start = Date.now();
      firstEntered();
      await sleep(300);
      const end = Date.now();
      spans.push({ writer: "first", start, end });
    });

    await firstStarted;

    const second = withWriteLock(filePath, async () => {
      const start = Date.now();
      await sleep(25);
      const end = Date.now();
      spans.push({ writer: "second", start, end });
    });

    await Promise.all([first, second]);

    const [firstSpan, secondSpan] = spans.sort((left, right) => left.start - right.start);
    expect(firstSpan.writer).toBe("first");
    expect(secondSpan.writer).toBe("second");
    expect(secondSpan.start).toBeGreaterThanOrEqual(firstSpan.end);
  });

  it("throws SwarmVaultLockError when contention exceeds retries", async () => {
    const filePath = await createTempStateFile();
    const release = await lockfile.lock(filePath, {
      stale: 30_000,
      realpath: false,
      lockfilePath: `${filePath}.lock`
    });

    try {
      await expect(withWriteLock(filePath, async () => undefined)).rejects.toBeInstanceOf(SwarmVaultLockError);
    } finally {
      await release();
    }
  }, 15_000);
});
