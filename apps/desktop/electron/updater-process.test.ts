import assert from 'node:assert/strict'
import { type SpawnOptions, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import {
  buildWindowsHandoffPayload,
  collectRelaunchArgs,
  describeUpdaterHandoffFailure,
  installationLauncherInvocation,
  killHandoffTree,
  MARKER_SELF_ADOPT_EPOCH_MS,
  observeUpdaterHandoff,
  resolvePosixScriptHandoff,
  resolveStagedUpdaterBinary,
  resolveUpdateScriptHandoff,
  sandboxFallbackFromEnv,
  spawnUpdaterProcess,
  stagedUpdaterSupportsPrewrittenMarker,
  WINDOWS_HANDOFF_BOOTSTRAP,
  WINDOWS_HANDOFF_PAYLOAD_ENV,
  WINDOWS_HANDOFF_PID_MARKER,
  windowsHandoffPidMarkerPattern,
  wrapHandoffForDetachedConsole
} from './updater-process'
import { windowsCmdPath, windowsPowerShellPath, windowsTaskkillPath } from './windows-powershell'

const DAY_MS = 24 * 60 * 60 * 1000

test('stagedUpdaterSupportsPrewrittenMarker rejects installers predating the self-adopt fix', () => {
  // The real-world trap: an installer staged at first install months ago, never
  // refreshed because copy_self_to_hermes_home no-ops during --update.
  assert.equal(
    stagedUpdaterSupportsPrewrittenMarker('C:\\Hermes\\hermes-setup.exe', {
      stagedMtimeMs: () => MARKER_SELF_ADOPT_EPOCH_MS - 60 * DAY_MS
    }),
    false
  )
})

test('stagedUpdaterSupportsPrewrittenMarker accepts installers from the fix onward', () => {
  assert.equal(
    stagedUpdaterSupportsPrewrittenMarker('C:\\Hermes\\hermes-setup.exe', {
      stagedMtimeMs: () => MARKER_SELF_ADOPT_EPOCH_MS
    }),
    true
  )
  assert.equal(
    stagedUpdaterSupportsPrewrittenMarker('C:\\Hermes\\hermes-setup.exe', {
      stagedMtimeMs: () => MARKER_SELF_ADOPT_EPOCH_MS + 30 * DAY_MS
    }),
    true
  )
})

test('stagedUpdaterSupportsPrewrittenMarker treats an unreadable mtime as unsupported', () => {
  // Bias toward the path that can always make progress: a skipped pre-write
  // loses anti-respawn hardening, a wedged updater can never update again.
  assert.equal(
    stagedUpdaterSupportsPrewrittenMarker('C:\\Hermes\\hermes-setup.exe', {
      stagedMtimeMs: () => null
    }),
    false
  )
})

test('resolveStagedUpdaterBinary still returns a stale staged updater on Windows', () => {
  // Staleness gates only the marker PRE-WRITE, never the hand-off itself:
  // the stale binary is the only updater these users have, and it works fine
  // once it is allowed to write its own claim.
  assert.equal(
    resolveStagedUpdaterBinary('C:\\Hermes', {
      fileExists: () => true,
      isWindows: true,
      stagedMtimeMs: () => MARKER_SELF_ADOPT_EPOCH_MS - 60 * DAY_MS
    }),
    path.join('C:\\Hermes', 'hermes-setup.exe')
  )
})

test('spawnUpdaterProcess hides the updater console and detaches the child on Windows', () => {
  const calls: Array<{ args: string[]; command: string; options: SpawnOptions }> = []
  let unrefCalls = 0

  const child = {
    pid: 4242,
    unref: () => {
      unrefCalls += 1
    }
  }

  const result = spawnUpdaterProcess(
    'hermes-setup.exe',
    ['--update', '--branch', 'main'],
    { cwd: 'C:\\Hermes', detached: true, stdio: 'ignore' },
    {
      isWindows: true,
      spawnProcess: (command, args, options) => {
        calls.push({ args, command, options })

        return child
      }
    }
  )

  assert.equal(result, child)
  assert.equal(unrefCalls, 1)
  assert.deepEqual(calls, [
    {
      args: ['--update', '--branch', 'main'],
      command: 'hermes-setup.exe',
      options: { cwd: 'C:\\Hermes', detached: true, shell: false, stdio: 'ignore', windowsHide: true }
    }
  ])
})

test('spawnUpdaterProcess preserves updater options off Windows', () => {
  let capturedOptions: SpawnOptions | undefined

  spawnUpdaterProcess(
    'hermes-setup',
    ['--update'],
    { detached: true, stdio: 'ignore' },
    {
      isWindows: false,
      spawnProcess: (_command, _args, options) => {
        capturedOptions = options

        return { unref: () => {} }
      }
    }
  )

  assert.deepEqual(capturedOptions, { detached: true, shell: false, stdio: 'ignore' })
})

test('spawnUpdaterProcess never invokes the updater through a shell', () => {
  let capturedOptions: SpawnOptions | undefined

  spawnUpdaterProcess(
    'hermes-setup',
    ['--update'],
    { detached: true, shell: true, stdio: 'ignore' },
    {
      isWindows: false,
      spawnProcess: (_command, _args, options) => {
        capturedOptions = options

        return { unref: () => {} }
      }
    }
  )

  assert.equal(capturedOptions?.shell, false)
})

test('resolveStagedUpdaterBinary hands Windows the staged installer it finds', () => {
  const home = 'C:\\Users\\hermes\\AppData\\Local\\hermes'
  const staged = path.join(home, 'hermes-setup.exe')
  const probed: string[] = []

  const resolved = resolveStagedUpdaterBinary(home, {
    fileExists: candidate => {
      probed.push(candidate)

      return candidate === staged
    },
    isWindows: true
  })

  assert.equal(resolved, staged)
  assert.deepEqual(probed, [staged])
})

test('resolveStagedUpdaterBinary returns null off Windows even when hermes-setup is staged (#74836)', () => {
  const home = '/Users/hermes/.hermes'
  let probes = 0

  const resolved = resolveStagedUpdaterBinary(home, {
    // The installer stages hermes-setup on macOS/Linux too, so "it exists" is
    // the normal case — and precisely the one that must not win.
    fileExists: () => {
      probes += 1

      return true
    },
    isWindows: false
  })

  assert.equal(resolved, null)
  assert.equal(probes, 0)
})

test('resolveStagedUpdaterBinary returns null on Windows when nothing is staged', () => {
  const resolved = resolveStagedUpdaterBinary('C:\\Users\\hermes\\AppData\\Local\\hermes', {
    fileExists: () => false,
    isWindows: true
  })

  assert.equal(resolved, null)
})

test('resolveUpdateScriptHandoff prefers the repo script on Windows when present', () => {
  const root = String.raw`C:\Users\hermes\AppData\Local\hermes\hermes-agent`
  const expected = path.join(root, 'scripts', 'desktop-update', 'windows.ps1')

  const handoff = resolveUpdateScriptHandoff(root, {
    isWindows: true,
    fileExists: candidate => candidate === expected
  })

  assert.ok(handoff)
  assert.equal(handoff.command, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`)
  assert.equal(handoff.scriptPath, expected)
  assert.deepEqual(handoff.args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', expected])
})

test('resolveUpdateScriptHandoff falls back to the pre-reorg flat path', () => {
  const root = String.raw`C:\Users\hermes\AppData\Local\hermes\hermes-agent`
  const legacy = path.join(root, 'scripts', 'desktop-update.ps1')

  const handoff = resolveUpdateScriptHandoff(root, {
    isWindows: true,
    fileExists: candidate => candidate === legacy
  })

  assert.ok(handoff)
  assert.equal(handoff.scriptPath, legacy)
})

test('resolveUpdateScriptHandoff returns null when the checkout predates the script', () => {
  const handoff = resolveUpdateScriptHandoff(String.raw`C:\Users\hermes\AppData\Local\hermes\hermes-agent`, {
    isWindows: true,
    fileExists: () => false
  })

  assert.equal(handoff, null)
})

test('resolveUpdateScriptHandoff is Windows-only (POSIX updates in place)', () => {
  const handoff = resolveUpdateScriptHandoff('/home/hermes/.hermes/hermes-agent', {
    isWindows: false,
    fileExists: () => true
  })

  assert.equal(handoff, null)
})

test('wrapHandoffForDetachedConsole uses a fixed bootstrap and keeps hand-off data out of cmd argv', () => {
  // #116161: `start /min` allocated a NEW (minimized, visible) console for
  // powershell on every hand-off; `detached: true` (DETACHED_PROCESS) would
  // leave the wrapper console-less, forcing the same allocation under `/b`.
  const root = String.raw`C:\Users\hermes\AppData\Local\hermes\hermes-agent`
  const expected = path.join(root, 'scripts', 'desktop-update', 'windows.ps1')

  const handoff = resolveUpdateScriptHandoff(root, {
    isWindows: true,
    fileExists: candidate => candidate === expected
  })

  assert.ok(handoff)

  const parameters = [
    { kind: 'value' as const, name: 'InstallRoot', value: root },
    { kind: 'value' as const, name: 'Branch', value: 'main&feature' },
    { kind: 'value' as const, name: 'DesktopPid', value: '123' },
    { kind: 'value' as const, name: 'RelaunchExe', value: 'C:\\Hermes & Co\\Hermes.exe' },
    { kind: 'switch' as const, name: 'NoGateway' },
    { kind: 'value' as const, name: 'HandoffRun', value: 'desk-123' }
  ]

  const wrapped = wrapHandoffForDetachedConsole(handoff, parameters, false, 123)

  assert.equal(wrapped.command, windowsCmdPath())
  assert.equal(wrapped.detached, false)
  assert.deepEqual(wrapped.args.slice(0, 6), ['/d', '/s', '/c', 'start', '', '/b'])
  assert.equal(wrapped.args.includes(expected), false)

  for (const parameter of parameters) {
    if (parameter.kind === 'value' && parameter.name !== 'DesktopPid') {
      assert.equal(wrapped.args.includes(parameter.value), false)
    }
  }

  const commandIndex = wrapped.args.indexOf('-Command')
  const invoker = wrapped.args[commandIndex + 1] ?? ''
  assert.equal(invoker.includes('\n'), false)
  assert.equal(invoker.includes('"'), false)
  assert.equal(invoker.slice(2).includes('&'), false)
  assert.match(
    invoker,
    /^& \(\[ScriptBlock\]::Create\(\[Text\.Encoding\]::Unicode\.GetString\(\[Convert\]::FromBase64String\('[A-Za-z0-9+/=]+'\)\)\)\)$/
  )
  const encodedBootstrap = invoker.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1]
  assert.ok(encodedBootstrap)
  assert.equal(Buffer.from(encodedBootstrap, 'base64').toString('utf16le'), WINDOWS_HANDOFF_BOOTSTRAP)
  assert.deepEqual(wrapped.args.slice(-2), [WINDOWS_HANDOFF_PID_MARKER, '123'])
  assert.equal(wrapped.args.filter((value: string): boolean => value === '123').length, 1)

  const encodedPayload = wrapped.handoffEnv[WINDOWS_HANDOFF_PAYLOAD_ENV]
  assert.ok(encodedPayload)
  assert.deepEqual(JSON.parse(Buffer.from(encodedPayload, 'base64').toString('utf8')), {
    scriptPath: expected,
    parameters
  })
})

test('wrapHandoffForDetachedConsole rejects invalid desktop pid markers', () => {
  const scriptPath = String.raw`C:\Hermes\update.ps1`

  const handoff = {
    command: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    args: ['-File', scriptPath],
    scriptPath
  }

  for (const desktopPid of [1.5, 0, -1, 10_000_000_000]) {
    assert.throws(() => wrapHandoffForDetachedConsole(handoff, [], false, desktopPid), /not a valid integer marker/)
  }
})

test('the Windows hand-off pid marker pattern has exact numeric boundaries', () => {
  const pattern = new RegExp(windowsHandoffPidMarkerPattern(123))

  assert.match(`powershell ${WINDOWS_HANDOFF_PID_MARKER} 123`, pattern)
  assert.doesNotMatch(`powershell ${WINDOWS_HANDOFF_PID_MARKER} 1234`, pattern)
  assert.doesNotMatch(`powershell ${WINDOWS_HANDOFF_PID_MARKER} 12`, pattern)
  assert.doesNotMatch(`powershell ${WINDOWS_HANDOFF_PID_MARKER} 123x`, pattern)
})

test.skipIf(process.platform !== 'win32')('the Windows bootstrap rejects a marker and payload pid mismatch', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hermes-handoff-marker-'))
  const scriptPath = path.join(root, 'update.ps1')

  try {
    writeFileSync(scriptPath, 'exit 0\r\n')

    const wrapped = wrapHandoffForDetachedConsole(
      {
        command: windowsPowerShellPath(),
        args: ['-NoProfile', '-File', scriptPath],
        scriptPath
      },
      [{ kind: 'value', name: 'DesktopPid', value: '124' }],
      true,
      123
    )

    const result = spawnSync(wrapped.command, wrapped.args, {
      encoding: 'utf8',
      env: { ...process.env, ...wrapped.handoffEnv },
      windowsHide: true
    })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /desktop pid marker does not match its payload/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('killHandoffTree targets the exact marker with absolute Windows executables', () => {
  let spawnedCommand = ''
  let spawnedArgs: string[] = []

  const fakeChild = {
    on: () => fakeChild
  }

  killHandoffTree(
    { pid: 456, exitCode: 0, signalCode: null, unref: () => {} },
    {
      isWindows: true,
      desktopPid: 123,
      spawnProcess: ((command: string, args: string[]) => {
        spawnedCommand = command
        spawnedArgs = args

        return fakeChild
      }) as never
    }
  )

  assert.equal(spawnedCommand, windowsPowerShellPath())
  assert.equal(spawnedArgs.at(-2), '-Command')
  const command = spawnedArgs.at(-1) ?? ''
  assert.ok(command.includes(`-match '${windowsHandoffPidMarkerPattern(123)}'`))
  assert.ok(command.includes(`& '${windowsTaskkillPath()}'`))
  assert.doesNotMatch(command, /(?:^|\s)taskkill\.exe(?:\s|$)/i)
})

test('killHandoffTree does nothing when Windows path resolution fails', () => {
  const originalSystemRoot: string | undefined = process.env.SystemRoot
  let spawned = false

  process.env.SystemRoot = String.raw`C:\Windows Root`

  try {
    assert.doesNotThrow(() => {
      killHandoffTree(
        { pid: 456, exitCode: 0, signalCode: null, unref: () => {} },
        {
          isWindows: true,
          desktopPid: 123,
          spawnProcess: (() => {
            spawned = true

            throw new Error('must not spawn')
          }) as never
        }
      )
    })
    assert.equal(spawned, false)
  } finally {
    if (originalSystemRoot === undefined) {
      delete process.env.SystemRoot
    } else {
      process.env.SystemRoot = originalSystemRoot
    }
  }
})

test('the legacy installation launcher uses the absolute System32 cmd.exe', (): void => {
  const launcher = String.raw`C:\Hermes\hermes.cmd`

  assert.equal(installationLauncherInvocation(launcher, true).command, windowsCmdPath())
})

test('buildWindowsHandoffPayload rejects invalid parameter names before encoding', () => {
  const scriptPath = String.raw`C:\Hermes\update.ps1`

  const handoff = {
    command: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    args: ['-File', scriptPath],
    scriptPath
  }

  assert.throws(
    () => buildWindowsHandoffPayload(handoff, [{ kind: 'value', name: 'Bad-Name', value: 'x' }]),
    /Invalid PowerShell parameter name/
  )
})

test('wrapHandoffForDetachedConsole uses a validated absolute PowerShell path', () => {
  const command = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
  const scriptPath = String.raw`C:\Hermes\update.ps1`

  const wrapped = wrapHandoffForDetachedConsole(
    {
      command,
      args: ['-NoProfile', '-File', scriptPath],
      scriptPath
    },
    [],
    true
  )

  assert.equal(wrapped.args[3], command)
})

test('wrapHandoffForDetachedConsole rejects unsafe PowerShell commands', () => {
  const scriptPath = String.raw`C:\Hermes\update.ps1`

  for (const command of [
    'powershell',
    'powershell.exe',
    'pwsh',
    String.raw`\\server\share\powershell.exe`,
    String.raw`\\?\C:\Windows\powershell.exe`,
    String.raw`\\.\C:\Windows\powershell.exe`,
    String.raw`C:/Windows/powershell.exe`,
    String.raw`C:\Windows/System32\powershell.exe`,
    String.raw`C:\Windows\..\Windows\powershell.exe`,
    String.raw`C:\Windows\.\powershell.exe`,
    String.raw`C:\Windows.\powershell.exe`,
    String.raw`C:\Windows \powershell.exe`,
    String.raw`C:\Windows\powershell.exe & calc.exe`,
    String.raw`C:\Windows Dir\powershell.exe`,
    String.raw`C:\Windows\powershell.exe"`
  ]) {
    assert.throws(
      () =>
        wrapHandoffForDetachedConsole(
          {
            command,
            args: ['-NoProfile', '-File', scriptPath],
            scriptPath
          },
          []
        ),
      /not a safe PowerShell executable path/
    )
  }
})

test('resolvePosixScriptHandoff returns the bash recipe when the script exists', () => {
  const root = '/home/hermes/.hermes/hermes-agent'
  const expected = path.join(root, 'scripts', 'desktop-update', 'posix.sh')

  const handoff = resolvePosixScriptHandoff(root, {
    isWindows: false,
    fileExists: candidate => candidate === expected
  })

  assert.ok(handoff)
  assert.equal(handoff.command, '/bin/bash')
  assert.deepEqual(handoff.args, [expected])
})

test('resolvePosixScriptHandoff is null when the checkout predates the script', () => {
  const handoff = resolvePosixScriptHandoff('/home/hermes/.hermes/hermes-agent', {
    isWindows: false,
    fileExists: () => false
  })

  assert.equal(handoff, null)
})

test('resolvePosixScriptHandoff is null on Windows', () => {
  const handoff = resolvePosixScriptHandoff(String.raw`C:\Users\hermes\AppData\Local\hermes\hermes-agent`, {
    isWindows: true,
    fileExists: () => true
  })

  assert.equal(handoff, null)
})

test('collectRelaunchArgs drops Electron internals, keeps user/launcher args', () => {
  const argv = [
    '--type=renderer',
    '--user-data-dir=/tmp/x',
    '--enable-features=A,B',
    '--field-trial-handle=123',
    '--enable-logging',
    '--log-file=/tmp/log',
    '--lang=en-US',
    '--inspect=9229',
    '--remote-debugging-port=9222',
    '--no-sandbox',
    'hermes://open/session/abc',
    '--profile=work'
  ]

  assert.deepEqual(collectRelaunchArgs(argv), ['--no-sandbox', 'hermes://open/session/abc', '--profile=work'])
  assert.deepEqual(collectRelaunchArgs(undefined), [])
})

test('sandboxFallbackFromEnv: ELECTRON_DISABLE_SANDBOX / --no-sandbox opt out', () => {
  assert.equal(sandboxFallbackFromEnv({ ELECTRON_DISABLE_SANDBOX: '1' }, []), true)
  assert.equal(sandboxFallbackFromEnv({ ELECTRON_DISABLE_SANDBOX: 'true' }, []), true)
  assert.equal(sandboxFallbackFromEnv({}, ['--no-sandbox']), true)
  assert.equal(sandboxFallbackFromEnv({ ELECTRON_DISABLE_SANDBOX: '0' }, []), false)
  assert.equal(sandboxFallbackFromEnv({}, []), false)
})

// ── observeUpdaterHandoff (#66753) ──────────────────────────────────────────

class FakeChild {
  pid = 1234
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  removed: string[] = []

  unref() {}

  once(event: string, listener: (...args: unknown[]) => void) {
    const arr = this.listeners.get(event) ?? []

    arr.push(listener)
    this.listeners.set(event, arr)

    return this
  }

  removeListener(event: string, _listener: (...args: unknown[]) => void) {
    this.removed.push(event)

    return this
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args)
    }
  }
}

function manualTimer() {
  const pending: Array<() => void> = []

  return {
    deps: {
      setTimeoutFn: (callback: () => void, _ms: number) => {
        pending.push(callback)

        return 0
      },
      clearTimeoutFn: () => {}
    },
    fire: () => {
      for (const callback of pending.splice(0)) {
        callback()
      }
    }
  }
}

test('observeUpdaterHandoff reports a spawn error instead of settling ok', async () => {
  const child = new FakeChild()
  const timer = manualTimer()
  const outcomePromise = observeUpdaterHandoff(child, 2500, timer.deps)

  const err: Error & { code?: string } = new Error('spawn ENOENT')

  err.code = 'ENOENT'
  child.emit('error', err)

  const outcome = await outcomePromise

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'spawn-error')
  assert.match(outcome.message ?? '', /ENOENT/)
})

test('observeUpdaterHandoff reports a non-zero early exit', async () => {
  const child = new FakeChild()
  const timer = manualTimer()
  const outcomePromise = observeUpdaterHandoff(child, 2500, timer.deps)

  child.emit('exit', 127, null)

  const outcome = await outcomePromise

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'early-exit')
  assert.equal(outcome.code, 127)
})

test('describeUpdaterHandoffFailure leads with plain copy and confines the raw outcome to Details', () => {
  for (const raw of ['updater exited 127 before the settle window elapsed', 'updater spawn failed: ENOENT']) {
    const text = describeUpdaterHandoffFailure({ message: raw })
    const [lead, details] = text.split('\n\nDetails: ')

    assert.ok(lead && !lead.includes(raw))
    assert.equal(details, raw)
  }

  assert.doesNotMatch(describeUpdaterHandoffFailure({}), /Details:/)
})

test('observeUpdaterHandoff reports a signal death inside the window', async () => {
  const child = new FakeChild()
  const timer = manualTimer()
  const outcomePromise = observeUpdaterHandoff(child, 2500, timer.deps)

  child.emit('exit', null, 'SIGTERM')

  const outcome = await outcomePromise

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'early-exit')
  assert.equal(outcome.signal, 'SIGTERM')
})

test('observeUpdaterHandoff accepts a clean exit 0 (Windows cmd start wrapper)', async () => {
  const child = new FakeChild()
  const timer = manualTimer()
  const outcomePromise = observeUpdaterHandoff(child, 2500, timer.deps)

  child.emit('exit', 0, null)

  const outcome = await outcomePromise

  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 0)
})

test('observeUpdaterHandoff settles ok when the child survives the window', async () => {
  const child = new FakeChild()
  const timer = manualTimer()
  const outcomePromise = observeUpdaterHandoff(child, 2500, timer.deps)

  timer.fire()

  const outcome = await outcomePromise

  assert.equal(outcome.ok, true)
  assert.equal(outcome.reason, undefined)
  // Listeners must be detached so a post-quit late exit can't fire them.
  assert.deepEqual(child.removed.sort(), ['error', 'exit'])
})

test('observeUpdaterHandoff ignores events after the first settle', async () => {
  const child = new FakeChild()
  const timer = manualTimer()
  const outcomePromise = observeUpdaterHandoff(child, 2500, timer.deps)

  child.emit('exit', 1, null)
  child.emit('error', new Error('late'))
  timer.fire()

  const outcome = await outcomePromise

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'early-exit')
})

test('observeUpdaterHandoff settles ok for children without an event interface', async () => {
  const timer = manualTimer()
  const outcomePromise = observeUpdaterHandoff({ pid: 1, unref: () => {} }, 2500, timer.deps)

  timer.fire()

  const outcome = await outcomePromise

  assert.equal(outcome.ok, true)
})
