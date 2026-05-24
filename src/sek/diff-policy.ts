/**
 * One diff-policy finding emitted by the SEK scanner.
 */
export interface DiffPolicyViolation {
  pattern: string
  description: string
  severity: 'block' | 'warn'
  location: string
}

const ADDITION_PATTERNS: Array<{
  pattern: RegExp
  description: string
  severity: 'block' | 'warn'
}> = [
  {
    pattern: /^\+.*\b(fetch|axios|http\.get|http\.post|https\.get|https\.post|got\(|request\()\b/m,
    description: 'New outbound HTTP call added',
    severity: 'warn'
  },
  {
    pattern: /^\+.*(password|secret|api_key|apikey|token|private_key)\s*=\s*['"`][^'"`]+['"`]/im,
    description: 'Hardcoded credential or secret detected',
    severity: 'block'
  },
  {
    pattern: /^\+.*(\|\|\s*true|&&\s*false|==\s*null\s*\|\||input\s*=\s*\{\})/m,
    description: 'Validation logic potentially weakened',
    severity: 'warn'
  },
  {
    pattern: /^\+.*(child_process|exec\s*\(|spawn\s*\(|execSync\s*\()/m,
    description: 'Shell execution call added',
    severity: 'block'
  }
]

const CICD_FILE_PATTERNS = ['.github/workflows', '.gitlab-ci', 'Jenkinsfile', '.circleci']
const DEPENDENCY_FILES = ['package.json', 'Cargo.toml', 'requirements.txt', 'go.mod']
const ENV_VAR_PATTERN = /\b(AWS_|GITHUB_TOKEN|API_KEY|SECRET_|PASSWORD_)[A-Z_]*\s*=/

/**
 * Scans diff content, PR text, and test output for SEK policy violations.
 *
 * This function never throws and returns every matching violation it can find.
 */
export function scanDiff(
  diff: string,
  prText: string,
  testOutput: string
): DiffPolicyViolation[] {
  try {
    const violations: DiffPolicyViolation[] = []
    const fileSections = splitDiffByFile(diff)

    for (const section of fileSections) {
      const filePath = section.filePath

      if (CICD_FILE_PATTERNS.some((pattern) => filePath.includes(pattern))) {
        violations.push({
          pattern: 'cicd_change',
          description: 'CI/CD configuration modified',
          severity: 'block',
          location: filePath
        })
      }

      if (DEPENDENCY_FILES.some((filename) => filePath.endsWith(filename)) && hasDependencyAddition(section.content, filePath)) {
        violations.push({
          pattern: 'dependency_addition',
          description: 'New dependency added',
          severity: 'warn',
          location: filePath
        })
      }

      for (const additionPattern of ADDITION_PATTERNS) {
        if (additionPattern.pattern.test(section.content)) {
          violations.push({
            pattern: additionPattern.pattern.source,
            description: additionPattern.description,
            severity: additionPattern.severity,
            location: filePath
          })
        }
      }
    }

    const combinedOutput = `${prText}\n${testOutput}`

    if (ENV_VAR_PATTERN.test(combinedOutput)) {
      violations.push({
        pattern: ENV_VAR_PATTERN.source,
        description: 'Environment variable name appears in PR text or test output',
        severity: 'block',
        location: prText.includes('=') ? 'pr text' : 'command output'
      })
    }

    return violations
  } catch {
    return []
  }
}

function splitDiffByFile(diff: string): Array<{ filePath: string; content: string }> {
  const sections: Array<{ filePath: string; content: string }> = []
  const parts = diff.split(/^diff --git /m).filter((part) => part.trim().length > 0)

  for (const part of parts) {
    const pathMatch = /^\S+\s+b\/([^\n]+)/m.exec(part)

    if (pathMatch === null) {
      continue
    }

    sections.push({
      filePath: pathMatch[1] ?? 'unknown',
      content: part
    })
  }

  return sections
}

function hasDependencyAddition(diffSection: string, filePath: string): boolean {
  if (filePath.endsWith('package.json')) {
    return /^\+"[^"]+"\s*:/m.test(diffSection)
  }

  if (filePath.endsWith('Cargo.toml')) {
    return /^\+[a-z].*=\s*"/m.test(diffSection)
  }

  if (filePath.endsWith('requirements.txt') || filePath.endsWith('go.mod')) {
    return /^\+[^+].+/m.test(diffSection)
  }

  return false
}
