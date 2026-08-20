import ts from 'typescript'

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const coreSourceRoot = path.join(repoRoot, 'packages/core/src')
const cliSourceRoot = path.join(repoRoot, 'packages/cli/src')

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(root, entry.name)
      if (entry.isDirectory()) return listTypeScriptFiles(filePath)
      return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [filePath] : []
    }),
  )
  return nested.flat()
}

function moduleSpecifiers(source: ts.SourceFile, runtimeOnly: boolean): string[] {
  const specifiers: string[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const hasRuntimeBinding =
        !clause ||
        (!clause.isTypeOnly &&
          (Boolean(clause.name) ||
            Boolean(
              clause.namedBindings &&
              (ts.isNamespaceImport(clause.namedBindings) ||
                clause.namedBindings.elements.some((element) => !element.isTypeOnly)),
            )))
      if (!runtimeOnly || hasRuntimeBinding) specifiers.push(node.moduleSpecifier.text)
      return
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const hasRuntimeBinding =
        !node.isTypeOnly &&
        (!node.exportClause ||
          ts.isNamespaceExport(node.exportClause) ||
          node.exportClause.elements.some((element) => !element.isTypeOnly))
      if (!runtimeOnly || hasRuntimeBinding) specifiers.push(node.moduleSpecifier.text)
      return
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
      return
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
  return specifiers
}

async function parseSource(filePath: string): Promise<ts.SourceFile> {
  const content = await readFile(filePath, 'utf8')
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind)
}

function resolveSourceImport(filePath: string, specifier: string, files: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null
  const resolved = path.resolve(path.dirname(filePath), specifier)
  const withoutRuntimeExtension = resolved.replace(/\.(?:c|m)?js$/, '')
  const candidates = [
    `${withoutRuntimeExtension}.ts`,
    `${withoutRuntimeExtension}.tsx`,
    path.join(withoutRuntimeExtension, 'index.ts'),
    path.join(withoutRuntimeExtension, 'index.tsx'),
  ]
  return candidates.find((candidate) => files.has(candidate)) ?? null
}

function displayPath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join('/')
}

function findCycles(graph: Map<string, string[]>): string[][] {
  const visited = new Set<string>()
  const active = new Set<string>()
  const stack: string[] = []
  const cycles: string[][] = []

  const visit = (filePath: string): void => {
    if (visited.has(filePath)) return
    visited.add(filePath)
    active.add(filePath)
    stack.push(filePath)

    for (const dependency of graph.get(filePath) ?? []) {
      if (!visited.has(dependency)) {
        visit(dependency)
      } else if (active.has(dependency)) {
        const cycleStart = stack.indexOf(dependency)
        cycles.push([...stack.slice(cycleStart), dependency].map(displayPath))
      }
    }

    stack.pop()
    active.delete(filePath)
  }

  for (const filePath of graph.keys()) visit(filePath)
  return cycles
}

describe('architecture boundaries', () => {
  it('keeps CLI imports on the public core package boundary', async () => {
    const violations: string[] = []
    for (const filePath of await listTypeScriptFiles(cliSourceRoot)) {
      const source = await parseSource(filePath)
      for (const specifier of moduleSpecifiers(source, false)) {
        if (specifier.includes('/core/src/') || specifier.endsWith('/core/src')) {
          violations.push(`${displayPath(filePath)} -> ${specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps the core runtime import graph acyclic', async () => {
    const files = new Set(await listTypeScriptFiles(coreSourceRoot))
    const graph = new Map<string, string[]>()

    for (const filePath of files) {
      const source = await parseSource(filePath)
      const dependencies = moduleSpecifiers(source, true)
        .map((specifier) => resolveSourceImport(filePath, specifier, files))
        .filter((dependency): dependency is string => dependency !== null)
      graph.set(filePath, dependencies)
    }

    expect(findCycles(graph)).toEqual([])
  })
})
