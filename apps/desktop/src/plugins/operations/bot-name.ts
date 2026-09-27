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

export const BOT_NAME_MAX_CHARS = 48
export const BOT_NAME_MAX_WORDS = 5

export interface BotNameCheck {
  error: string
  name: string
  valid: boolean
  warnings: string[]
}

/** Collapse whitespace and trim, the way the registry stores a name. */
export function normalizeBotName(value: string): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isBotNameCharacter(character: string): boolean {
  return /\p{L}/u.test(character) || character === "'" || character === '-'
}

export function checkBotName(value: string, otherBotNames: string[] = []): BotNameCheck {
  const name = normalizeBotName(value)
  const fail = (error: string): BotNameCheck => ({ error, name, valid: false, warnings: [] })

  if (!name) {
    return fail('Enter a name, like Darrell.')
  }

  if (name.length > BOT_NAME_MAX_CHARS) {
    return fail(`Keep the name to ${BOT_NAME_MAX_CHARS} characters or fewer.`)
  }

  if (name.split(' ').length > BOT_NAME_MAX_WORDS) {
    return fail(`Keep the name to ${BOT_NAME_MAX_WORDS} words or fewer.`)
  }

  if (!/\p{L}/u.test(name)) {
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
  const lowered = name.toLowerCase()
  const duplicates = otherBotNames
    .map(candidate => normalizeBotName(candidate))
    .filter(candidate => candidate.toLowerCase() === lowered)

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
