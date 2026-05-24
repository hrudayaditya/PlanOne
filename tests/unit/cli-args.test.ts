import { describe, expect, it } from 'vitest'

import { parseArgs } from '../../src/cli.js'

describe('cli args', () => {
  it('parses task and repo correctly', () => {
    expect(parseArgs(['--task', 'fix bug', '--repo', '/tmp'])).toEqual({
      task: 'fix bug',
      repo: '/tmp'
    })
  })

  it('returns true for a flag without a value', () => {
    expect(parseArgs(['--flag'])).toEqual({ flag: true })
  })

  it('includes unknown flags in the result', () => {
    expect(parseArgs(['--mystery', 'value'])).toEqual({ mystery: 'value' })
  })

  it('returns an empty object for empty argv', () => {
    expect(parseArgs([])).toEqual({})
  })
})
