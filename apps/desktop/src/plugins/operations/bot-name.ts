/**
 * What an operator may name one of their own Bots.
 *
 * A Bot's name is what the roster, the rooms, and the connected chat show, so it
 * stays short, plainly typed, and easy to tell apart from the other Bots. This
 * module mirrors the backend rule (plugins/harness_agents/registry.py) so the app
 * refuses a name the registry would refuse, before anything travels. The registry
 * stays the authority; this only keeps the answer instant and explains the rules.
 *
 * One limit is worth stating plainly because it surprises operators: a second Bot
 * with the same name is allowed, but the two then read the same in the roster and
 * the rooms, so the collision is reported rather than hidden.
 */

import alphaRanges from './bot-name-alpha-ranges.json'
import casefoldMap from './bot-name-casefold.json'
import whitespaceRanges from './bot-name-whitespace-ranges.json'

export const BOT_NAME_MAX_CHARS = 48
export const BOT_NAME_MAX_WORDS = 5

export interface BotNameCheck {
  error: string
  name: string
  valid: boolean
  warnings: string[]
}

function isWhitespaceCodePoint(cp: number): boolean {
  for (const [start, end] of whitespaceRanges) {
    if (cp < start) {
      return false
    }

    if (cp <= end) {
      return true
    }
  }

  return false
}

/** Collapse whitespace and trim, the way the registry stores a name. */
export function normalizeBotName(value: string): string {
  const name = String(value ?? '')
  const words: string[] = []
  let current = ''

  for (const ch of name) {
    const cp = ch.codePointAt(0) ?? 0

    if (isWhitespaceCodePoint(cp)) {
      if (current) {
        words.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }

  if (current) {
    words.push(current)
  }

  return words.join(' ')
}

/** Count Unicode code points the way the registry counts characters. */
function countBotNameCharacters(value: string): number {
  return Array.from(value).length
}

/** True when the code point is a letter on the Python interpreter the backend runs. */
function isAlphaCodePoint(cp: number): boolean {
  for (const [start, end] of alphaRanges) {
    if (cp < start) {
      return false
    }

    if (cp <= end) {
      return true
    }
  }

  return false
}

function isBotNameCharacter(character: string): boolean {
  const cp = character.codePointAt(0) ?? 0

  return isAlphaCodePoint(cp) || character === "'" || character === '-'
}

/** Return the comparison key used to spot two Bots that display the same name.
 *
 * This mirrors Python's str.casefold() on the serving interpreter so the
 * renderer and the registry agree. Characters that casefold differently from
 * JS toLowerCase() are driven by a table generated from the pinned interpreter.
 */
export function botNameKey(value: string): string {
  const name = normalizeBotName(value)
  let key = ''

  for (const ch of name) {
    const cp = ch.codePointAt(0) ?? 0
    const mapped = (casefoldMap as Record<string, string>)[String(cp)] ?? ch.toLowerCase()

    key += mapped
  }

  return key
}

export function checkBotName(value: string, otherBotNames: string[] = []): BotNameCheck {
  const name = normalizeBotName(value)
  const fail = (error: string): BotNameCheck => ({ error, name, valid: false, warnings: [] })

  if (!name) {
    return fail('Enter a name, like Darrell.')
  }

  if (countBotNameCharacters(name) > BOT_NAME_MAX_CHARS) {
    return fail(`Keep the name to ${BOT_NAME_MAX_CHARS} characters or fewer.`)
  }

  if (name.split(' ').length > BOT_NAME_MAX_WORDS) {
    return fail(`Keep the name to ${BOT_NAME_MAX_WORDS} words or fewer.`)
  }

  if (!Array.from(name).some(character => isAlphaCodePoint(character.codePointAt(0) ?? 0))) {
    return fail('The name needs at least one letter.')
  }

  for (const character of name) {
    if (character === ' ') {
      continue
    }

    if (isBotNameCharacter(character)) {
      continue
    }

    return fail('Use letters, spaces, apostrophes, or hyphens.')
  }

  const warnings: string[] = []
  const key = botNameKey(name)

  const duplicates = otherBotNames
    .map(candidate => normalizeBotName(candidate))
    .filter(candidate => botNameKey(candidate) === key)

  if (duplicates.length) {
    warnings.push(
      `Another Bot already uses the name ${name}, so the two look the same in the roster and the rooms.`
    )
  }

  if (name.includes("'") || name.includes('-')) {
    warnings.push('Apostrophes and hyphens are allowed, but one plain word is easier to read and to say.')
  }

  return { error: '', name, valid: true, warnings }
}

/** The line shown after a rename lands. */
export function botRenameConfirmation(name: string, warnings: string[] = []): string {
  return [`Saved. This Bot is now ${normalizeBotName(name)}.`, ...warnings].join(' ')
}
