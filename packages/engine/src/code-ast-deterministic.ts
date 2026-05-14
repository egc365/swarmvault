import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export type AstFramework =
  | "next-app" | "next-pages" | "hono" | "express" | "fastify" | "koa" | "nestjs" | "elysia" | "adonis" | "trpc"
  | "sveltekit" | "remix" | "nuxt" | "flask" | "fastapi" | "django" | "celery" | "go-net-http" | "gin" | "fiber" | "echo"
  | "chi" | "rails" | "phoenix" | "spring" | "ktor" | "actix" | "axum" | "raw-http" | "php" | "laravel" | "aspnet"
  | "vapor" | "swiftui" | "flutter" | "android" | "roku-scenegraph" | "graphql" | "grpc" | "websocket" | "angular";
export type AstRoute = { method: string; path: string; file: string; line: number; framework: AstFramework; confidence: "ast" | "regex" };
export type AstSchema = { name: string; file: string; line: number; orm: string; fields: Array<{ name: string; type: string; flags: string[] }> };
export type AstExport = { name: string; kind: string; file: string; line: number; signature?: string };
export type AstScanResult = { root: string; frameworks: AstFramework[]; routes: AstRoute[]; schemas: AstSchema[]; exports: AstExport[] };

const FRAMEWORK_DEPS: Array<[AstFramework, string[]]> = [
  ["hono", ["hono"]], ["express", ["express"]], ["fastify", ["fastify"]], ["koa", ["koa"]], ["nestjs", ["@nestjs/core", "@nestjs/common"]],
  ["elysia", ["elysia"]], ["adonis", ["@adonisjs/core"]], ["trpc", ["@trpc/server"]], ["angular", ["@angular/core"]],
  ["sveltekit", ["@sveltejs/kit"]], ["remix", ["@remix-run/node", "@remix-run/react"]], ["nuxt", ["nuxt"]],
  ["graphql", ["graphql", "apollo-server"]], ["grpc", ["@grpc/grpc-js"]], ["websocket", ["ws", "socket.io"]]
];
const HTTP = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".svelte-kit", "coverage", "target"]);

async function exists(file: string): Promise<boolean> { return fs.access(file).then(() => true, () => false); }
async function read(file: string): Promise<string> { return fs.readFile(file, "utf8").catch(() => ""); }
function rel(root: string, file: string): string { return path.relative(root, file).replace(/\\/g, "/"); }
function lineOf(text: string, pos: number): number { return text.slice(0, Math.max(0, pos)).split(/\r?\n/).length; }
function str(node: ts.Node): string | undefined {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}
function propName(node: ts.PropertyName | undefined, sf: ts.SourceFile): string {
  return node ? node.getText(sf).replace(/^['"]|['"]$/g, "") : "";
}

async function files(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) { if (!IGNORE.has(entry.name)) await walk(path.join(dir, entry.name)); }
      else if (/\.(tsx?|jsx?|py|go|rb|php|rs|java|kt|cs|dart|swift|prisma)$/.test(entry.name)) out.push(path.join(dir, entry.name));
    }
  }
  await walk(root); return out;
}

async function detectFrameworks(root: string): Promise<AstFramework[]> {
  const pkg = JSON.parse((await read(path.join(root, "package.json"))) || "{}");
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const found: AstFramework[] = [];
  if (deps.next) found.push((await exists(path.join(root, "app"))) || (await exists(path.join(root, "src/app"))) ? "next-app" : "next-pages");
  for (const [fw, names] of FRAMEWORK_DEPS) if (names.some((name) => deps[name])) found.push(fw);
  const py = `${await read(path.join(root, "requirements.txt"))}\n${await read(path.join(root, "pyproject.toml"))}`.toLowerCase();
  if (py.includes("fastapi")) found.push("fastapi"); if (py.includes("flask")) found.push("flask"); if (py.includes("django")) found.push("django"); if (py.includes("celery")) found.push("celery");
  const go = await read(path.join(root, "go.mod")); if (go.includes("gin-gonic/gin")) found.push("gin"); if (go.includes("gofiber/fiber")) found.push("fiber"); if (go.includes("go-chi/chi")) found.push("chi"); if (go.includes("labstack/echo")) found.push("echo");
  if ((await read(path.join(root, "Cargo.toml"))).includes("actix-web")) found.push("actix"); if ((await read(path.join(root, "Cargo.toml"))).includes("axum")) found.push("axum");
  if ((await read(path.join(root, "composer.json"))).includes("laravel/framework")) found.push("laravel");
  if ((await read(path.join(root, "Gemfile"))).includes("rails")) found.push("rails"); if ((await read(path.join(root, "mix.exs"))).includes("phoenix")) found.push("phoenix");
  if ((await read(path.join(root, "Package.swift"))).includes("vapor")) found.push("vapor"); if (await exists(path.join(root, "pubspec.yaml"))) found.push("flutter");
  return [...new Set<AstFramework>(found.length ? found : ["raw-http"])];
}

function nextPath(root: string, file: string): string | null {
  const r = rel(root, file); const m = r.match(/(?:^|\/)(?:src\/)?app(\/.*?)\/route\.[tj]sx?$/);
  return m ? (m[1].replace(/\/\([^)]+\)/g, "").replace(/\[([^\]]+)\]/g, ":$1") || "/") : null;
}

function scanTs(root: string, file: string, text: string, frameworks: AstFramework[]): Pick<AstScanResult, "routes" | "schemas" | "exports"> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const routes: AstRoute[] = [], schemas: AstSchema[] = [], exports: AstExport[] = [];
  const np = frameworks.includes("next-app") ? nextPath(root, file) : null;
  function visit(node: ts.Node): void {
    if (np && ts.isFunctionDeclaration(node) && node.name && HTTP.has(node.name.text.toLowerCase())) routes.push({ method: node.name.text.toUpperCase(), path: np, file: rel(root, file), line: lineOf(text, node.getStart(sf)), framework: "next-app", confidence: "ast" });
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text.toLowerCase(), pathArg = node.arguments[0];
      if (HTTP.has(method) && pathArg && str(pathArg)?.startsWith("/")) routes.push({ method: method.toUpperCase(), path: str(pathArg)!, file: rel(root, file), line: lineOf(text, node.getStart(sf)), framework: frameworks.find((fw) => ["express", "hono", "fastify", "koa", "elysia"].includes(fw)) ?? "raw-http", confidence: "ast" });
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["pgTable", "mysqlTable", "sqliteTable"].includes(node.expression.text)) {
      const table = node.arguments[0] && str(node.arguments[0]); const obj = node.arguments[1];
      if (table && obj && ts.isObjectLiteralExpression(obj)) schemas.push({ name: table, file: rel(root, file), line: lineOf(text, node.getStart(sf)), orm: "drizzle", fields: obj.properties.filter(ts.isPropertyAssignment).map((p) => ({ name: propName(p.name, sf), type: fieldType(p.initializer, sf), flags: p.initializer.getText(sf).includes("primaryKey") ? ["pk"] : p.initializer.getText(sf).includes("notNull") ? ["required"] : [] })) });
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.name && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) exports.push({ name: node.name.text, kind: ts.SyntaxKind[node.kind].replace("Declaration", "").toLowerCase(), file: rel(root, file), line: lineOf(text, node.getStart(sf)), signature: node.getText(sf).split("{")[0].trim() });
    ts.forEachChild(node, visit);
  }
  visit(sf); return { routes, schemas, exports };
}

function fieldType(node: ts.Expression, sf: ts.SourceFile): string {
  let current: ts.Expression = node;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) current = current.expression.expression;
  return ts.isCallExpression(current) ? current.expression.getText(sf) : "unknown";
}

function scanRegex(root: string, file: string, text: string, frameworks: AstFramework[]): AstRoute[] {
  const routes: AstRoute[] = [], fw = frameworks[0] ?? "raw-http";
  for (const m of text.matchAll(/@(app|router)\.(get|post|put|patch|delete)\(["']([^"']+)["']\)|\.(GET|POST|PUT|PATCH|DELETE)\(["']([^"']+)["']\)/g)) routes.push({ method: (m[2] ?? m[4]).toUpperCase(), path: m[3] ?? m[5], file: rel(root, file), line: lineOf(text, m.index ?? 0), framework: fw, confidence: "regex" });
  return routes;
}

function scanPrisma(root: string, file: string, text: string): AstSchema[] {
  return [...text.matchAll(/model\s+(\w+)\s+\{([\s\S]*?)\}/g)].map((m) => ({ name: m[1], file: rel(root, file), line: lineOf(text, m.index ?? 0), orm: "prisma", fields: m[2].split(/\r?\n/).map((l) => l.trim().match(/^(\w+)\s+([\w\[\]?]+)/)).filter((x): x is RegExpMatchArray => Boolean(x)).map((x) => ({ name: x[1], type: x[2], flags: [] })) }));
}

export async function scanAstDeterministic(rootDir: string): Promise<AstScanResult> {
  const root = path.resolve(rootDir), frameworks = await detectFrameworks(root), all = await files(root);
  const result: AstScanResult = { root, frameworks, routes: [], schemas: [], exports: [] };
  for (const file of all) {
    const text = await read(file);
    if (/\.[tj]sx?$/.test(file)) { const found = scanTs(root, file, text, frameworks); result.routes.push(...found.routes); result.schemas.push(...found.schemas); result.exports.push(...found.exports); }
    else { result.routes.push(...scanRegex(root, file, text, frameworks)); if (file.endsWith(".prisma")) result.schemas.push(...scanPrisma(root, file, text)); }
  }
  result.routes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.method.localeCompare(b.method));
  result.schemas.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  result.exports.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return result;
}
