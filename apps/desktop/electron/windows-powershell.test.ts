import assert from 'node:assert/strict'

import { afterEach, test, vi } from 'vitest'

import { resolveWindowsSystemPaths } from './windows-powershell'

afterEach((): void => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

test('Windows system paths use SystemRoot before other environment spellings', (): void => {
  const paths = resolveWindowsSystemPaths({
    SystemRoot: String.raw`D:\Windows`,
    SYSTEMROOT: String.raw`E:\Windows`,
    windir: String.raw`F:\Windows`
  })

  assert.equal(paths.WINDOWS_ROOT, String.raw`D:\Windows`)
  assert.equal(paths.CMD_PATH, String.raw`D:\Windows\System32\cmd.exe`)
  assert.equal(paths.POWERSHELL_PATH, String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`)
  assert.equal(paths.TASKKILL_PATH, String.raw`D:\Windows\System32\taskkill.exe`)
})

test('Windows system paths fall back to C:\\Windows when the environment is unset', (): void => {
  assert.equal(resolveWindowsSystemPaths({}).WINDOWS_ROOT, String.raw`C:\Windows`)
})

test('Windows system paths accept exactly one trailing backslash', (): void => {
  assert.equal(resolveWindowsSystemPaths({ SystemRoot: 'C:\\Windows\\' }).WINDOWS_ROOT, String.raw`C:\Windows`)
})

test.each([
  String.raw`C:\Windows Root`,
  'C:\\',
  'C:\\Windows\\\\',
  String.raw`\\server\share`,
  String.raw`Windows`,
  String.raw`C:\Windows\..\Other`,
  String.raw`C:\Windows&Other`
])('Windows system paths reject an unsafe root: %s', (root: string): void => {
  assert.throws((): void => {
    resolveWindowsSystemPaths({ SystemRoot: root })
  }, /Invalid Windows system root/)
})

test('update modules can be imported before an invalid Windows root is needed', async (): Promise<void> => {
  vi.stubEnv('SystemRoot', String.raw`C:\Program Files\Win`)
  vi.resetModules()

  await assert.doesNotReject(async (): Promise<void> => {
    await Promise.all([
      import('./updater-process'),
      import('./updater/checkout'),
      import('./updater/relaunch-waiter'),
      import('./updater/state-db-preflight')
    ])
  })
})
