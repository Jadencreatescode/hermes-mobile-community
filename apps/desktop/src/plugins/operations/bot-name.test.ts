import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  BOT_NAME_MAX_CHARS,
  BOT_NAME_MAX_WORDS,
  botNameKey,
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

  it('treats Python whitespace the same as the registry', () => {
    // U+001C..U+001F and U+0085 are whitespace in Python str.split() but not in JS \s
    expect(normalizeBotName('A\u001CB')).toBe('A B')
    expect(normalizeBotName('A\u001DB')).toBe('A B')
    expect(normalizeBotName('A\u001EB')).toBe('A B')
    expect(normalizeBotName('A\u001FB')).toBe('A B')
    expect(normalizeBotName('A\u0085B')).toBe('A B')
  })

  it('does not treat U+FEFF as whitespace', () => {
    expect(normalizeBotName('A\uFEFFB')).toBe('A\uFEFFB')
  })

  it('reads a missing value as empty', () => {
    expect(normalizeBotName(undefined as unknown as string)).toBe('')
  })
})

describe('botNameKey', () => {
  it('collapses spacing like the registry', () => {
    expect(botNameKey('  Darrell jones  ')).toBe('darrell jones')
  })

  it('matches the sharp-s pair (Strasse vs Stra\u00dfe)', () => {
    expect(botNameKey('Strasse')).toBe(botNameKey('Stra\u00dfe'))
  })

  it('matches the sharp s on its own', () => {
    expect(botNameKey('\u00df')).toBe('ss')
  })

  it('matches the ff ligature', () => {
    expect(botNameKey('\ufb00')).toBe('ff')
  })

  it('matches the fi ligature', () => {
    expect(botNameKey('\ufb01')).toBe('fi')
  })

  it('matches Greek Sigma in its three forms', () => {
    const sigma = botNameKey('\u03a3') // Σ
    expect(botNameKey('\u03c3')).toBe(sigma) // σ
    expect(botNameKey('\u03c2')).toBe(sigma) // ς
  })

  it('matches Turkish dotted and dotless i', () => {
    expect(botNameKey('\u0130')).toBe('i\u0307')
    expect(botNameKey('I')).toBe('i')
    expect(botNameKey('\u0131')).toBe('\u0131')
  })

  it('leaves fullwidth Darrell different from ASCII', () => {
    expect(botNameKey('\uff24arrell')).not.toBe(botNameKey('darrell'))
  })

  it('leaves composed and decomposed e acute different', () => {
    expect(botNameKey('\u00e9')).not.toBe(botNameKey('e\u0301'))
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

  it('does not warn about a name no other Bot holds', () => {
    expect(checkBotName('Darrell', ['Goose']).warnings).toEqual([])
  })

  it('warns about a case variant of another Bot\u2019s name', () => {
    const result = checkBotName('darrell', ['Darrell'])

    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/already uses the name darrell/)
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

  it('counts astral characters the same as the registry', () => {
    const astral = '\u{10400}'.repeat(25)

    expect(checkBotName(astral).valid).toBe(true)
  })

  it('refuses an astral name past the character limit', () => {
    const astral = '\u{10400}'.repeat(49)

    expect(checkBotName(astral).valid).toBe(false)
    expect(checkBotName(astral).error).toContain(`${BOT_NAME_MAX_CHARS} characters`)
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
