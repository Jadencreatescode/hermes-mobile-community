import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  BOT_NAME_MAX_CHARS,
  BOT_NAME_MAX_WORDS,
  botRenameConfirmation,
  checkBotName,
  normalizeBotName
} from './bot-name'

interface SharedNameCase {
  name: string
  valid: boolean
  why: string
}

/** The same fixture the backend name-rule suite reads, so the two rules cannot drift. */
function readSharedCases(): SharedNameCase[] {
  const candidates = [
    resolve(process.cwd(), '../../tests/fixtures/bot_name_cases.json'),
    resolve(process.cwd(), 'tests/fixtures/bot_name_cases.json')
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, 'utf-8')).cases
    }
  }

  throw new Error(`bot_name_cases.json is not reachable from ${process.cwd()}`)
}

const sharedCases: SharedNameCase[] = readSharedCases()

describe('shared name fixtures', () => {
  it('reads the same boundary cases the backend suite reads', () => {
    expect(sharedCases.length).toBeGreaterThanOrEqual(20)
    expect(sharedCases.some(entry => entry.valid)).toBe(true)
    expect(sharedCases.some(entry => !entry.valid)).toBe(true)
  })

  it.each(sharedCases)('renderer rule agrees with the shared verdict: $why', entry => {
    const result = checkBotName(entry.name)

    expect({ name: entry.name, valid: result.valid }).toEqual({ name: entry.name, valid: entry.valid })
  })
})

describe('normalizeBotName', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeBotName('  Mary   Jane  ')).toBe('Mary Jane')
  })

  it('reads a missing value as empty', () => {
    expect(normalizeBotName(undefined as unknown as string)).toBe('')
  })
})

describe('checkBotName', () => {
  it('accepts a plain name', () => {
    const result = checkBotName('Darrell')

    expect(result).toMatchObject({ error: '', name: 'Darrell', valid: true, warnings: [] })
  })

  it('accepts an empty list of other Bot names', () => {
    expect(checkBotName('Marisol').valid).toBe(true)
  })

  it('accepts letters outside the Latin alphabet', () => {
    expect(checkBotName('\u4e2d\u6587\u540d').valid).toBe(true)
    expect(checkBotName('M\u00fcller').valid).toBe(true)
  })

  it('reads a name it cannot use as invalid and says why', () => {
    const result = checkBotName('Darrell!')

    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/letters, spaces, apostrophes, or hyphens/)
  })

  it('refuses an empty name', () => {
    expect(checkBotName('   ').error).toBe('Enter a name, like Darrell.')
  })

  it('refuses digits', () => {
    const result = checkBotName('R2 Unit')

    expect(result.valid).toBe(false)
  })

  it(`refuses a name longer than ${BOT_NAME_MAX_CHARS} characters`, () => {
    const result = checkBotName(`Darrell ${'a'.repeat(BOT_NAME_MAX_CHARS)}`)

    expect(result.valid).toBe(false)
    expect(result.error).toContain(`${BOT_NAME_MAX_CHARS} characters`)
  })

  it(`refuses more than ${BOT_NAME_MAX_WORDS} words`, () => {
    const result = checkBotName('one two three four five six')

    expect(result.valid).toBe(false)
    expect(result.error).toContain(`${BOT_NAME_MAX_WORDS} words`)
  })

  it('refuses a name with no letters', () => {
    const result = checkBotName("'- '")

    expect(result.valid).toBe(false)
  })

  it('warns when another Bot already uses the name, without refusing it', () => {
    const result = checkBotName('Darrell', ['Goose', 'darrell '])

    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/already uses the name Darrell/)
  })

  it('does not warn about a name no other Bot holds', () => {
    expect(checkBotName('Darrell', ['Goose', 'Pi']).warnings).toEqual([])
  })

  it('notes that apostrophes and hyphens read harder, without refusing them', () => {
    const result = checkBotName("O'Brien", [])

    expect(result.valid).toBe(true)
    expect(result.warnings.some(warning => warning.includes('Apostrophes and hyphens'))).toBe(true)
  })

  it('never promises an ear or a wake phrase', () => {
    const copy = [
      ...checkBotName('Darrell', ['Darrell']).warnings,
      botRenameConfirmation('Darrell', []),
      checkBotName('R2 Unit').error
    ].join(' ')

    expect(copy.toLowerCase()).not.toContain('wake')
    expect(copy.toLowerCase()).not.toContain('ear')
    expect(copy).not.toContain('hey ')
  })
})

describe('botRenameConfirmation', () => {
  it('names the Bot that was saved', () => {
    expect(botRenameConfirmation('  Darrell ')).toBe('Saved. This Bot is now Darrell.')
  })

  it('carries the warnings through', () => {
    const line = botRenameConfirmation('Darrell', ['Another Bot already uses the name Darrell.'])

    expect(line).toContain('Saved. This Bot is now Darrell.')
    expect(line).toContain('Another Bot already uses the name Darrell.')
  })
})
