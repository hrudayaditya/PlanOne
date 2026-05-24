import { describe, expect, it } from 'vitest'

import { assignAbMode } from '../../src/ab-test/index.js'

describe('assignAbMode', () => {
  it('assigns mode A to task 10', () => {
    expect(assignAbMode(10)).toBe('A')
  })

  it('assigns mode B to tasks 1-9', () => {
    for (let taskNumber = 1; taskNumber <= 9; taskNumber += 1) {
      expect(assignAbMode(taskNumber)).toBe('B')
    }
  })

  it('assigns mode C to task 20', () => {
    expect(assignAbMode(20)).toBe('C')
  })

  it('assigns mode D to task 30', () => {
    expect(assignAbMode(30)).toBe('D')
  })

  it('is pure for the same input', () => {
    expect(assignAbMode(40)).toBe(assignAbMode(40))
  })
})
