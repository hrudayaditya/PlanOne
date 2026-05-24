import { describe, expect, it } from 'vitest'

import { getPreloadCandidatePathsForStep, getStepPhase, sanitizeSymbols } from '../../src/executor/step.js'
import type { ExecutionStep } from '../../src/orchestrator/plan.js'

describe('executor prompt helpers', () => {
  it('filters noise symbols before prompt interpolation', () => {
    expect(sanitizeSymbols(['Client', 'Local', 'createTRPCNext', 'T'])).toEqual(['createTRPCNext'])
  })

  it('classifies the test-writing step from its description', () => {
    const step: ExecutionStep = {
      stepIndex: 3,
      description: 'Add or update tests',
      approach: 'Write a regression test',
      affectedSymbols: [],
      affectedFiles: [],
      estimatedRisk: 'low',
      dependsOn: [],
      isCheckpoint: false
    }

    expect(getStepPhase(step)).toBe('testing')
  })

  it('preloads related test files first during the testing step', () => {
    const step: ExecutionStep = {
      stepIndex: 2,
      description: 'Add or update tests',
      approach: 'Write a regression test',
      affectedSymbols: [],
      affectedFiles: [],
      estimatedRisk: 'low',
      dependsOn: [],
      isCheckpoint: false
    }

    const preloadedPaths = getPreloadCandidatePathsForStep(step, {
      primaryFiles: [
        { path: 'astroid/scoped_nodes.py', confidence: 'high', reason: 'confirmed', lineCount: 10 }
      ],
      symbols: [],
      fileContents: new Map(),
      searchHits: [],
      relatedTestFiles: [
        {
          path: 'tests/unittest_scoped_nodes.py',
          confidence: 'high',
          sourceFile: 'astroid/scoped_nodes.py',
          reason: 'naming convention: unittest_scoped_nodes.py for scoped_nodes.py'
        }
      ]
    }, ['astroid/scoped_nodes.py'])

    expect(preloadedPaths).toEqual([
      'tests/unittest_scoped_nodes.py',
      'astroid/scoped_nodes.py'
    ])
  })

  it('keeps implementation-step preloading focused on implementation files', () => {
    const step: ExecutionStep = {
      stepIndex: 1,
      description: 'Implement the fix',
      approach: 'Update the implementation',
      affectedSymbols: [],
      affectedFiles: [],
      estimatedRisk: 'low',
      dependsOn: [],
      isCheckpoint: false
    }

    const preloadedPaths = getPreloadCandidatePathsForStep(step, {
      primaryFiles: [
        { path: 'astroid/scoped_nodes.py', confidence: 'high', reason: 'confirmed', lineCount: 10 }
      ],
      symbols: [],
      fileContents: new Map(),
      searchHits: [],
      relatedTestFiles: [
        {
          path: 'tests/unittest_scoped_nodes.py',
          confidence: 'high',
          sourceFile: 'astroid/scoped_nodes.py',
          reason: 'naming convention: unittest_scoped_nodes.py for scoped_nodes.py'
        }
      ]
    }, ['astroid/scoped_nodes.py'])

    expect(preloadedPaths).toEqual(['astroid/scoped_nodes.py'])
  })
})
