import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface RepoContext {
  repoRoot: string
  primaryLanguage: string
  hasTests: boolean
  testFramework: string | null
  packageManager: 'npm' | 'yarn' | 'pnpm' | 'cargo' | 'pip' | null
  language: 'python' | 'typescript' | 'javascript' | 'rust' | 'go' | 'unknown'
  pythonBinary: string | null
  testRunner: string | null
  testFilePattern: string | null
  testCommand: string | null
}

export async function detectRepoContext(repoRoot: string): Promise<RepoContext> {
  const hasPyproject = pathExists(repoRoot, 'pyproject.toml')
  const hasSetupPy = pathExists(repoRoot, 'setup.py')
  const hasSetupCfg = pathExists(repoRoot, 'setup.cfg')
  const hasPackageJson = pathExists(repoRoot, 'package.json')
  const hasCargoToml = pathExists(repoRoot, 'Cargo.toml')
  const hasGoMod = pathExists(repoRoot, 'go.mod')
  const hasMakefile = pathExists(repoRoot, 'Makefile')

  const pyproject = readTextIfExists(repoRoot, 'pyproject.toml')
  const setupCfg = readTextIfExists(repoRoot, 'setup.cfg')
  const toxIni = readTextIfExists(repoRoot, 'tox.ini')
  const pytestIni = readTextIfExists(repoRoot, 'pytest.ini')
  const pythonVersion = readTextIfExists(repoRoot, '.python-version')?.trim() ?? null
  const packageJson = parsePackageJson(readTextIfExists(repoRoot, 'package.json'))
  const makefile = readTextIfExists(repoRoot, 'Makefile')

  const language = detectLanguage({
    hasPyproject,
    hasSetupPy,
    hasSetupCfg,
    hasPackageJson,
    hasCargoToml,
    hasGoMod,
    hasMakefile,
    makefile
  })
  const pythonBinary = language === 'python'
    ? detectPythonBinary(pythonVersion, pyproject)
    : null
  const testRunner = detectTestRunner(language, { pyproject, setupCfg, toxIni, packageJson })
  const testFilePattern = detectTestFilePattern(language, { pyproject, pytestIni })
  const testCommand = buildRepoContextTestCommand(language, testRunner, pythonBinary)

  return {
    repoRoot,
    primaryLanguage: toPrimaryLanguage(language),
    hasTests: testRunner !== null || testFilePattern !== null,
    testFramework: testRunner,
    packageManager: detectPackageManager(language, packageJson, {
      hasCargoToml,
      hasGoMod,
      hasPyproject,
      hasSetupPy,
      hasSetupCfg
    }),
    language,
    pythonBinary,
    testRunner,
    testFilePattern,
    testCommand
  }
}

function pathExists(repoRoot: string, relativePath: string): boolean {
  return existsSync(resolve(repoRoot, relativePath))
}

function readTextIfExists(repoRoot: string, relativePath: string): string | null {
  const absolutePath = resolve(repoRoot, relativePath)
  if (!existsSync(absolutePath)) {
    return null
  }

  try {
    return readFileSync(absolutePath, 'utf8')
  } catch {
    return null
  }
}

function parsePackageJson(text: string | null): {
  scripts?: Record<string, string>
  devDependencies?: Record<string, string>
  dependencies?: Record<string, string>
} | null {
  if (text === null) {
    return null
  }

  try {
    return JSON.parse(text) as {
      scripts?: Record<string, string>
      devDependencies?: Record<string, string>
      dependencies?: Record<string, string>
    }
  } catch {
    return null
  }
}

function detectLanguage(input: {
  hasPyproject: boolean
  hasSetupPy: boolean
  hasSetupCfg: boolean
  hasPackageJson: boolean
  hasCargoToml: boolean
  hasGoMod: boolean
  hasMakefile: boolean
  makefile: string | null
}): RepoContext['language'] {
  if (input.hasPyproject || input.hasSetupPy || input.hasSetupCfg) {
    return 'python'
  }
  if (input.hasPackageJson) {
    const makefileHint = input.makefile?.split('\n')[0]?.toLowerCase() ?? ''
    if (makefileHint.includes('ts') || makefileHint.includes('node') || makefileHint.includes('npm')) {
      return 'typescript'
    }
    return 'typescript'
  }
  if (input.hasCargoToml) {
    return 'rust'
  }
  if (input.hasGoMod) {
    return 'go'
  }
  if (input.hasMakefile) {
    const firstLine = input.makefile?.split('\n')[0]?.toLowerCase() ?? ''
    if (firstLine.includes('python')) return 'python'
    if (firstLine.includes('node') || firstLine.includes('ts')) return 'typescript'
    if (firstLine.includes('cargo') || firstLine.includes('rust')) return 'rust'
    if (firstLine.includes('go')) return 'go'
  }
  return 'unknown'
}

function detectPythonBinary(pythonVersion: string | null, pyproject: string | null): string {
  if (pythonVersion !== null && pythonVersion.length > 0) {
    return pythonVersion.startsWith('python') ? pythonVersion : `python${pythonVersion}`
  }

  const requiresPython = pyproject?.match(/requires-python\s*=\s*["']([^"']+)["']/)?.[1] ?? null
  if (requiresPython !== null && /3/.test(requiresPython)) {
    return 'python3'
  }

  return 'python3'
}

function detectTestRunner(
  language: RepoContext['language'],
  input: {
    pyproject: string | null
    setupCfg: string | null
    toxIni: string | null
    packageJson: {
      scripts?: Record<string, string>
      devDependencies?: Record<string, string>
      dependencies?: Record<string, string>
    } | null
  }
): string | null {
  if (language === 'python') {
    const combined = `${input.pyproject ?? ''}\n${input.setupCfg ?? ''}\n${input.toxIni ?? ''}`.toLowerCase()
    if (combined.includes('pytest')) {
      return 'pytest'
    }
    return 'pytest'
  }

  if (language === 'typescript' || language === 'javascript') {
    const scripts = input.packageJson?.scripts ?? {}
    const deps = {
      ...(input.packageJson?.dependencies ?? {}),
      ...(input.packageJson?.devDependencies ?? {})
    }

    if (typeof scripts.test === 'string' && scripts.test.includes('vitest')) {
      return 'vitest'
    }
    if (typeof scripts.test === 'string' && scripts.test.includes('jest')) {
      return 'jest'
    }
    if (typeof deps.vitest === 'string') {
      return 'vitest'
    }
    if (typeof deps.jest === 'string') {
      return 'jest'
    }
    if (typeof scripts.test === 'string') {
      return 'test'
    }
    return null
  }

  if (language === 'rust') {
    return 'cargo test'
  }
  if (language === 'go') {
    return 'go test'
  }

  return null
}

function detectTestFilePattern(
  language: RepoContext['language'],
  input: {
    pyproject: string | null
    pytestIni: string | null
  }
): string | null {
  if (language === 'python') {
    const pythonFilesMatch = input.pyproject?.match(/python_files\s*=\s*\[([^\]]+)\]/)
      ?? input.pytestIni?.match(/python_files\s*=\s*(.+)/)
    if (pythonFilesMatch?.[1] !== undefined) {
      return pythonFilesMatch[1].replace(/["'\s]/g, ' ').trim().replace(/\s+/g, ' ')
    }
    return 'test_*.py *_test.py'
  }

  if (language === 'typescript' || language === 'javascript') {
    return '*.test.ts *.spec.ts *.test.js *.spec.js'
  }

  return null
}

function buildRepoContextTestCommand(
  language: RepoContext['language'],
  testRunner: string | null,
  pythonBinary: string | null
): string | null {
  if (language === 'python') {
    return `${pythonBinary ?? 'python3'} -m ${testRunner ?? 'pytest'}`
  }
  if (language === 'typescript' || language === 'javascript') {
    if (testRunner === 'vitest') return 'npx vitest run'
    if (testRunner === 'jest') return 'npx jest'
    if (testRunner === 'test') return 'npm test'
  }
  if (language === 'rust') {
    return 'cargo test'
  }
  if (language === 'go') {
    return 'go test ./...'
  }
  return null
}

function detectPackageManager(
  language: RepoContext['language'],
  packageJson: {
    scripts?: Record<string, string>
    devDependencies?: Record<string, string>
    dependencies?: Record<string, string>
  } | null,
  input: {
    hasCargoToml: boolean
    hasGoMod: boolean
    hasPyproject: boolean
    hasSetupPy: boolean
    hasSetupCfg: boolean
  }
): RepoContext['packageManager'] {
  if (language === 'python' || input.hasPyproject || input.hasSetupPy || input.hasSetupCfg) {
    return 'pip'
  }
  if (input.hasCargoToml) {
    return 'cargo'
  }
  if (input.hasGoMod) {
    return null
  }
  if (packageJson !== null) {
    return 'npm'
  }
  return null
}

function toPrimaryLanguage(language: RepoContext['language']): string {
  switch (language) {
    case 'python':
      return 'Python'
    case 'typescript':
      return 'TypeScript'
    case 'javascript':
      return 'JavaScript'
    case 'rust':
      return 'Rust'
    case 'go':
      return 'Go'
    default:
      return 'Unknown'
  }
}
