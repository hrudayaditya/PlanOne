import { describe, expect, it } from 'vitest'

import { recoverPseudoToolCall, repairToolArgs } from '../../src/executor/tool-repair.js'

describe('tool repair helpers', () => {
  it("repairs list_directory args from reasoning text", () => {
    expect(repairToolArgs('list_directory', {}, 'Let me explore the packages/next directory to understand the structure.'))
      .toEqual({ path: 'packages/next' })
  })

  it("repairs read_file args from reasoning text", () => {
    expect(repairToolArgs('read_file', {}, 'Let me read withTRPC.tsx before patching it.'))
      .toEqual({ path: 'withTRPC.tsx' })
  })

  it('recovers pseudo-tool-calls from plain text', () => {
    expect(recoverPseudoToolCall('Tool call (list_directory): {"path":"packages/next"}'))
      .toEqual({ name: 'list_directory', input: { path: 'packages/next' } })
  })

  it('returns null for malformed pseudo-tool-call JSON', () => {
    expect(recoverPseudoToolCall('Tool call (list_directory): {"path":"packages/next"')).toBeNull()
  })
})
