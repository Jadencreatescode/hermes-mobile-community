import path from 'node:path'

export interface WindowsSystemPaths {
  CMD_PATH: string
  POWERSHELL_PATH: string
  TASKKILL_PATH: string
  WINDOWS_ROOT: string
}

const UNSAFE_WINDOWS_ROOT_SEGMENT: RegExp = /[\s"'%&|<>^!;,=()`,:*?]/

/**
 * Resolve the Windows root and fail closed before deriving executable paths.
 * Supported Windows installations do not place the system root in a path with spaces.
 */
export function resolveWindowsSystemPaths(env: NodeJS.ProcessEnv): WindowsSystemPaths {
  const configuredRoot: string = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows'
  const root: string =
    configuredRoot.length > 3 && configuredRoot.endsWith('\\') && !configuredRoot.endsWith('\\\\')
      ? configuredRoot.slice(0, -1)
      : configuredRoot
  const segments: string[] = root.slice(3).split('\\')

  if (
    !/^[A-Za-z]:\\/.test(root) ||
    root.includes('/') ||
    path.win32.normalize(root) !== root ||
    segments.some(
      (segment: string): boolean =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.endsWith('.') ||
        UNSAFE_WINDOWS_ROOT_SEGMENT.test(segment)
    )
  ) {
    throw new Error(`Invalid Windows system root: ${JSON.stringify(root)}`)
  }

  const system32: string = path.win32.join(root, 'System32')

  return {
    WINDOWS_ROOT: root,
    CMD_PATH: path.win32.join(system32, 'cmd.exe'),
    POWERSHELL_PATH: path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    TASKKILL_PATH: path.win32.join(system32, 'taskkill.exe')
  }
}

/** Absolute system executable paths: update hand-offs must never consult cwd or PATH. */
export function windowsCmdPath(): string {
  return resolveWindowsSystemPaths(process.env).CMD_PATH
}

export function windowsPowerShellPath(): string {
  return resolveWindowsSystemPaths(process.env).POWERSHELL_PATH
}

export function windowsTaskkillPath(): string {
  return resolveWindowsSystemPaths(process.env).TASKKILL_PATH
}
