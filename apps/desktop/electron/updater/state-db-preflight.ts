import { execFileSync } from 'node:child_process'

import { hiddenWindowsChildOptions } from '../windows-child-options'
import { windowsCmdPath } from '../windows-powershell'

interface StateDbPreflight {
  python: string | null
  script: string
  home: string
  log: (message: string) => void
  /**
   * The installation launcher of a PM-managed checkout (`.hermes/bin/hermes`).
   * A managed checkout carries no venv of its own — the launcher owns
   * interpreter and generation selection there — so the snapshot runs through
   * it exactly like the update check does (`readSourceUpdate`).
   */
  launcher?: string | null
}

const SNAPSHOT_TIMEOUT_MS = 30_000

function runDirect(command: string, args: string[]): string {
  return execFileSync(
    command,
    args,
    hiddenWindowsChildOptions({
      encoding: 'utf8',
      timeout: SNAPSHOT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    })
  )
}

export function guardedStateDbCmdArgs(command: string, args: string[]): string[] {
  for (const value of [command, ...args]) {
    if (/["%&|<>^\r\n]/.test(value)) {
      throw new Error('The pre-flight snapshot contains an unsafe Windows command argument.')
    }
  }

  const commandLine = `""${command}" ${args.map((arg: string): string => `"${arg}"`).join(' ')}"`
  return ['/d', '/v:off', '/s', '/c', commandLine]
}

export function stateDbPreflightInvocation(command: string, args: string[]): { args: string[]; command: string } {
  return { command: windowsCmdPath(), args: guardedStateDbCmdArgs(command, args) }
}

function runViaCmd(command: string, args: string[]): string {
  const invocation = stateDbPreflightInvocation(command, args)

  return execFileSync(
    invocation.command,
    invocation.args,
    hiddenWindowsChildOptions({
      encoding: 'utf8',
      timeout: SNAPSHOT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: true
    })
  )
}

// Synchronous by design: the caller must not stop the backend before the snapshot.
export function preflightStateDb({ python, script, home, log, launcher = null }: StateDbPreflight): void {
  try {
    const command: string | null = launcher ?? python

    if (!command) {
      throw new Error('Python not found')
    }

    const args: string[] = launcher ? ['--run-module', 'hermes_cli.backup_sqlite', home] : ['-I', '-S', script, home]

    // Node refuses direct .cmd execFile; an older published launcher can still
    // be one. Same fail-closed guard as the update check: shell:true would
    // interpolate untrusted paths, so keep cmd.exe's one unavoidable parse
    // closed instead.
    const viaCmd: boolean = process.platform === 'win32' && /\.cmd$/i.test(command)

    const result: string = viaCmd ? runViaCmd(command, args) : runDirect(command, args)

    log(`[updates] state.db pre-flight: ${result.trim()}`)
  } catch (error: unknown) {
    const message =
      `state.db pre-flight failed: ${error instanceof Error ? error.message : String(error)}. ` +
      'Update cancelled before backend shutdown. Update the selected installation with its hermes update command, then retry.'

    log(`[updates] ${message}`)
    throw new Error(message, { cause: error })
  }
}
