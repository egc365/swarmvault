import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanAstDeterministic } from "../../src/index.js";

const tempDirs: string[] = [];
async function tmp(): Promise<string> { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sv-ast-scan-")); tempDirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe("AST-only deterministic code extraction", () => {
  it("extracts exact TS routes, schemas, and exports without fuzzy matching", async () => {
    const root = await tmp(); await fs.mkdir(path.join(root, "src", "app", "api", "users"), { recursive: true }); await fs.mkdir(path.join(root, "src", "db"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { next: "14.0.0", express: "4.18.0", "drizzle-orm": "0.30.0" }, devDependencies: { typescript: "5.0.0" } }), "utf8");
    await fs.writeFile(path.join(root, "tsconfig.json"), "{\"compilerOptions\":{}}\n", "utf8");
    await fs.writeFile(path.join(root, "src", "app", "api", "users", "route.ts"), ["import { NextResponse } from 'next/server';", "export async function GET() { return NextResponse.json([]); }", "export async function POST() { return NextResponse.json({ ok: true }); }"].join("\n"), "utf8");
    await fs.writeFile(path.join(root, "src", "server.ts"), ["import express from 'express';", "export function boot() {", "  const app = express();", "  app.get('/health', health);", "}", "export function health() { return 'ok'; }"].join("\n"), "utf8");
    await fs.writeFile(path.join(root, "src", "db", "schema.ts"), ["import { pgTable, serial, text } from 'drizzle-orm/pg-core';", "export const users = pgTable('users', {", "  id: serial('id').primaryKey(),", "  email: text('email').notNull()", "});"].join("\n"), "utf8");
    const scan = await scanAstDeterministic(root);
    expect(scan.frameworks).toEqual(["next-app", "express"]);
    expect(scan.routes.map((r) => ({ method: r.method, path: r.path, file: r.file, line: r.line, confidence: r.confidence }))).toEqual([
      { method: "GET", path: "/api/users", file: "src/app/api/users/route.ts", line: 2, confidence: "ast" },
      { method: "POST", path: "/api/users", file: "src/app/api/users/route.ts", line: 3, confidence: "ast" },
      { method: "GET", path: "/health", file: "src/server.ts", line: 4, confidence: "ast" }
    ]);
    expect(scan.schemas).toEqual([{ name: "users", file: "src/db/schema.ts", line: 2, orm: "drizzle", fields: [{ name: "id", type: "serial", flags: ["pk"] }, { name: "email", type: "text", flags: ["required"] }] }]);
    expect(scan.exports.map((e) => `${e.kind}:${e.name}:${e.file}:${e.line}`)).toEqual(["function:GET:src/app/api/users/route.ts:2", "function:POST:src/app/api/users/route.ts:3", "function:boot:src/server.ts:2", "function:health:src/server.ts:6"]);
  });
});
