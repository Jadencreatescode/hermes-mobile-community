import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, vi } from 'vitest'

import { WINDOWS_HANDOFF_PAYLOAD_ENV } from '../updater-process'
import { windowsCmdPath } from '../windows-powershell'

import {
  RELAUNCH_WAITER_LOG_TAIL_BYTES,
  type RelaunchWaiterHandle,
  type SpawnWaiter,
  startRelaunchWaiter,
  waiterLogTail,
  windowsPowerShellPath
} from './relaunch-waiter'

const scriptPath: string = path.resolve(import.meta.dirname, '../../scripts/update-relaunch-waiter.ps1')

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'close')
    child.kill()
    await exited
  }
}

function isWaiterStage(stage: string): boolean {
  return (
    path.dirname(path.resolve(stage)) === path.resolve(os.tmpdir()) &&
    /^hermes-relaunch-[^/\\]+$/.test(path.basename(stage))
  )
}

for (const mode of [
  { name: 'ready', ready: true },
  { name: 'silent', ready: false },
  { name: 'spawn-error', ready: false, missing: true },
  { name: 'early-exit', ready: false, earlyExit: true },
  { name: 'cancel-timeout', ready: true, refuseKill: true },
  { name: 'startup-cancel-timeout', ready: false, refuseKill: true },
  { name: 'cleanup-error', ready: true, refuseCleanup: true }
]) {
  test(`waiter ownership survives its complete lifecycle (${mode.name})`, async (): Promise<void> => {
    let child: ChildProcess | undefined
    let originalKill: ChildProcess['kill'] | undefined
    let stage: string = ''
    let stageVerified: boolean = false
    let closed: boolean = false
    const cleanupError: Error = new Error('fixture staging cleanup refused')

    const start: SpawnWaiter = (command: string, args: string[], options: Parameters<SpawnWaiter>[2]): ChildProcess => {
      const encodedPayload = options.env[WINDOWS_HANDOFF_PAYLOAD_ENV]
      assert.ok(encodedPayload, 'the waiter payload must be present in the child environment')

      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64').toString('utf8')) as {
        scriptPath: string
        parameters: Array<{ kind: string; name: string; value?: string }>
      }

      const payloadReadyFile: string | undefined = payload.parameters.find(
        parameter => parameter.name === 'ReadyFile'
      )?.value
      assert.ok(payloadReadyFile, 'the waiter payload must contain the ready-file value')
      const candidateStage: string = path.dirname(payloadReadyFile)
      assert.equal(isWaiterStage(candidateStage), true, 'the waiter stage must be a direct child of the OS temp dir')
      stage = candidateStage
      const readyFile: string = path.join(stage, 'ready.txt')
      assert.equal(command, windowsCmdPath())
      assert.deepEqual(
        { ...options, env: undefined },
        { cwd: os.tmpdir(), detached: false, env: undefined, stdio: 'ignore', windowsHide: true }
      )
      assert.notEqual(stage, path.dirname(scriptPath))
      assert.deepEqual(fs.readFileSync(path.join(stage, 'update-relaunch-waiter.ps1')), fs.readFileSync(scriptPath))
      stageVerified = true
      assert.equal(args.length, 13)
      assert.deepEqual(args.slice(0, 10), [
        '/d',
        '/s',
        '/c',
        windowsPowerShellPath(),
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command'
      ])
      assert.match(
        args[10] ?? '',
        /^& \(\[ScriptBlock\]::Create\(\[Text\.Encoding\]::Unicode\.GetString\(\[Convert\]::FromBase64String\('[A-Za-z0-9+/=]+'\)\)\)\)$/
      )
      assert.deepEqual(args.slice(-2), ['-HermesDesktopPidMarker', String(process.pid)])
      assert.deepEqual(payload, {
        scriptPath: path.join(stage, 'update-relaunch-waiter.ps1'),
        parameters: [
          { kind: 'value', name: 'ProcessId', value: String(process.pid) },
          { kind: 'value', name: 'ProcessStartTimeMs', value: '1000000' },
          { kind: 'value', name: 'IdentityName', value: 'disposable-waiter-test' },
          { kind: 'value', name: 'ReadyFile', value: readyFile },
          { kind: 'value', name: 'TimeoutSeconds', value: '900' }
        ]
      })

      // ProcessId intentionally equals the final ownership marker, so only that payload value may appear in argv.
      for (const dynamicValue of [
        payload.scriptPath,
        ...payload.parameters.flatMap(parameter =>
          (parameter.name === 'ProcessId' && parameter.value === String(process.pid)) || parameter.value === undefined
            ? []
            : [parameter.value]
        )
      ]) {
        assert.equal(args.includes(dynamicValue), false)
      }

      child = spawn(
        mode.missing ? path.join(stage, 'missing.exe') : process.execPath,
        [
          '-e',
          `
        const fs = require('node:fs');
        if (process.env.TEST_EXIT === 'yes') process.exit(3);
        if (process.env.TEST_READY === 'yes') fs.writeFileSync(process.env.READY_FILE, 'ready');
        setInterval(() => {}, 1000);
      `
        ],
        {
          ...options,
          env: {
            ...process.env,
            READY_FILE: readyFile,
            TEST_READY: mode.ready ? 'yes' : 'no',
            TEST_EXIT: mode.earlyExit ? 'yes' : 'no'
          }
        }
      )
      originalKill = child.kill.bind(child)

      if (mode.refuseKill) {
        child.kill = () => false
      }

      child.once('close', () => {
        closed = true
      })

      return child
    }

    try {
      const starting: Promise<RelaunchWaiterHandle | undefined> = startRelaunchWaiter(
        {
          processId: process.pid,
          processStartTimeMs: 1_000_000,
          identityName: 'disposable-waiter-test',
          scriptPath
        },
        {
          spawn: start,
          kill: child => {
            child.kill()
          },
          handshakeTimeoutMs: mode.ready ? 10_000 : 2_000,
          cancelTimeoutMs: 2_000,
          pollMs: 20
        }
      )

      if (!mode.ready && mode.refuseKill) {
        await assert.rejects(starting, /did not exit after cancellation/)
        assert.equal(closed, false)
        assert.equal(fs.existsSync(stage), true)

        return
      }

      const handle = await starting

      if (mode.ready) {
        assert.ok(handle && typeof handle === 'object', 'readiness must retain the cancellation handle')
        assert.equal(closed, false)

        if (mode.refuseCleanup) {
          const remove = fs.promises.rm.bind(fs.promises)
          vi.spyOn(fs.promises, 'rm').mockImplementation((file, options) => {
            return file === stage ? Promise.reject(cleanupError) : remove(file, options)
          })
        }

        const cancelled = handle.cancel()
        assert.equal(handle.cancel(), cancelled, 'concurrent cancellation shares its result')

        if (mode.refuseKill || mode.refuseCleanup) {
          await assert.rejects(cancelled, error =>
            mode.refuseCleanup
              ? error === cleanupError
              : error instanceof Error && error.message.includes('did not exit after cancellation')
          )
          assert.equal(handle.cancel(), cancelled)
          assert.equal(closed, !mode.refuseKill)
          assert.equal(fs.existsSync(stage), true)

          return
        }

        await cancelled
        await handle.cancel()
      } else {
        assert.equal(handle, undefined, 'a failed start has no live mechanism')
      }

      assert.equal(closed, true, 'the actual child has exited before the caller proceeds')
      assert.equal(fs.existsSync(stage), false)
    } finally {
      vi.restoreAllMocks()

      if (child && originalKill) {
        child.kill = originalKill
      }

      await stop(child)

      if (stageVerified && isWaiterStage(stage)) {
        fs.rmSync(stage, { recursive: true, force: true })
      }
    }
  }, 20_000)
}

test('missing scripts refuse startup before spawning a waiter', async (): Promise<void> => {
  let spawned: boolean = false
  assert.equal(
    await startRelaunchWaiter(
      {
        processId: process.pid,
        processStartTimeMs: 1_000_000,
        identityName: 'disposable-waiter-test',
        scriptPath: path.join(scriptPath, 'absent.ps1')
      },
      {
        spawn: (): never => {
          spawned = true
          throw new Error('missing scripts must not spawn')
        }
      }
    ),
    undefined
  )
  assert.equal(spawned, false)
})

test('every failed start tells the log why it failed', async (): Promise<void> => {
  const logs: string[] = []
  const log = (message: string): void => void logs.push(message)

  await startRelaunchWaiter(
    {
      processId: process.pid,
      processStartTimeMs: 1_000_000,
      identityName: 'disposable-waiter-test',
      scriptPath: path.join(scriptPath, 'absent.ps1')
    },
    { log }
  )
  assert.match(logs.join('\n'), /cannot copy .*absent\.ps1/)

  logs.length = 0
  await startRelaunchWaiter(
    { processId: process.pid, processStartTimeMs: 1_000_000, identityName: 'disposable-waiter-test', scriptPath },
    {
      log,
      spawn: (): never => {
        throw new Error('EACCES fixture')
      }
    }
  )
  assert.match(logs.join('\n'), /resolving or spawning PowerShell threw: Error: EACCES fixture/)

  logs.length = 0
  await startRelaunchWaiter(
    { processId: process.pid, processStartTimeMs: 1_000_000, identityName: 'disposable-waiter-test', scriptPath },
    {
      log,
      pollMs: 20,
      spawn: (_command, _args, options): ChildProcess =>
        spawn(process.execPath, ['-e', 'process.exit(2)'], { ...options, stdio: 'ignore' })
    }
  )
  assert.match(logs.join('\n'), /exited before its handshake after \d+ms \(exit code 2/)

  logs.length = 0
  await startRelaunchWaiter(
    { processId: process.pid, processStartTimeMs: 1_000_000, identityName: 'disposable-waiter-test', scriptPath },
    {
      log,
      pollMs: 20,
      handshakeTimeoutMs: 200,
      kill: child => {
        child.kill()
      },
      spawn: (_command, _args, options): ChildProcess =>
        spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options, stdio: 'ignore' })
    }
  )
  assert.match(logs.join('\n'), /no handshake within 200ms \(pid \d+\); stopping it/)
}, 20_000)

test('an invalid Windows root logs and refuses the waiter before spawning', async (): Promise<void> => {
  const logs: string[] = []
  const spawn = vi.fn<SpawnWaiter>()
  vi.stubEnv('SystemRoot', String.raw`C:\Program Files\Win`)

  try {
    const handle = await startRelaunchWaiter(
      {
        processId: process.pid,
        processStartTimeMs: 1_000_000,
        identityName: 'disposable-waiter-test',
        scriptPath
      },
      { log: message => logs.push(message), spawn }
    )

    assert.equal(handle, undefined)
    assert.equal(spawn.mock.calls.length, 0)
    assert.match(logs.join('\n'), /Invalid Windows system root/)
  } finally {
    vi.unstubAllEnvs()
  }
})

test('the script log report keeps only this attempt, reads a bounded suffix, and decodes UTF-8', (): void => {
  const dir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'waiter-log-'))
  const file: string = path.join(dir, 'waiter.log')

  try {
    // Older attempt's lines, then enough filler to push them past the bounded read.
    const filler: string = `t [hermes-relaunch-old] pid=1 ${'x'.repeat(200)}\n`.repeat(
      Math.ceil(RELAUNCH_WAITER_LOG_TAIL_BYTES / 200) + 5
    )

    fs.writeFileSync(
      file,
      `t [hermes-relaunch-gone] pid=2 stale line\n${filler}t [hermes-relaunch-me] pid=3 pfad C:\\Benutzer\\Jörg fehlgeschlagen\nt [hermes-relaunch-other] pid=4 not mine\n`,
      'utf8'
    )

    const report: string = waiterLogTail(file, 'hermes-relaunch-me')
    assert.match(report, /Jörg fehlgeschlagen/)
    assert.doesNotMatch(report, /not mine|stale line|\[hermes-relaunch-old\]/)
    assert.equal(waiterLogTail(file, 'hermes-relaunch-gone'), `${file}:\nno lines from this attempt`)
    // Every physical line of a multi-line script error carries the tag, so none is dropped.
    fs.writeFileSync(
      file,
      [
        't [hermes-relaunch-me] pid=3 failed: Exception: run.ps1:1',
        't [hermes-relaunch-me] pid=3 Line |',
        't [hermes-relaunch-me] pid=3  | first line second line third line',
        't [hermes-relaunch-other] pid=4 not mine'
      ].join('\n'),
      'utf8'
    )
    const multi: string = waiterLogTail(file, 'hermes-relaunch-me')
    assert.match(multi, /Line \|/)
    assert.match(multi, /third line/)
    assert.doesNotMatch(multi, /not mine/)
    assert.match(waiterLogTail(path.join(dir, 'absent.log'), 'x'), /not written/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
