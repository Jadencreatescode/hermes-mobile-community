import type { HermesReadFileTextResult, HermesSelectPathsOptions } from '@/global'

const IMAGE_MIME: Record<string, string> = {
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tiff: 'image/tiff',
  webp: 'image/webp'
}

function extension(value: string): string {
  return value.replace(/^\./, '').toLowerCase()
}

function mimeForExtension(value: string): string {
  const ext = extension(value)

  return IMAGE_MIME[ext] || 'application/octet-stream'
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(typeof reader.result === 'string' ? reader.result : ''))
    reader.addEventListener('error', () => reject(reader.error || new Error('Could not read selected file')))
    reader.readAsDataURL(blob)
  })
}

// Match Electron's dedicated non-image attachment cap. Check before FileReader
// base64-expands the selected file so mobile Safari cannot exhaust the tab.
export const BROWSER_ATTACHMENT_MAX_BYTES = 256 * 1024 * 1024

export interface BrowserFileRegistry {
  getPathForFile: (file: File) => string
  readDataUrl: (path: string) => Promise<string>
  readText: (path: string) => Promise<HermesReadFileTextResult>
  register: (file: File) => string
  release: (path: string) => boolean
  saveBuffer: (data: ArrayBuffer | Uint8Array, ext: string) => Promise<string>
  saveClipboardImage: () => Promise<string>
  selectPaths: (options?: HermesSelectPathsOptions) => Promise<string[]>
}

export function createBrowserFileRegistry(): BrowserFileRegistry {
  const files = new Map<string, File>()
  const pathByFile = new WeakMap<File, string>()

  const register = (file: File): string => {
    const existing = pathByFile.get(file)

    if (existing) {return existing}

    const id = crypto.randomUUID()
    const path = `browser-file://${id}/${encodeURIComponent(file.name || 'attachment')}`
    files.set(path, file)
    pathByFile.set(file, path)

    return path
  }

  const requireFile = (path: string): File => {
    const file = files.get(path)

    if (!file) {throw new Error('The selected browser file is no longer available. Attach it again.')}

    return file
  }

  const readDataUrl = async (path: string): Promise<string> => {
    const file = requireFile(path)

    if (file.size > BROWSER_ATTACHMENT_MAX_BYTES) {
      throw new Error(
        `Could not read selected file: file is too large (${file.size} bytes; limit ${BROWSER_ATTACHMENT_MAX_BYTES} bytes)`
      )
    }

    return dataUrl(file)
  }

  const selectPaths = (options: HermesSelectPathsOptions = {}): Promise<string[]> => {
    if (options.directories) {return Promise.resolve([])}

    return new Promise(resolve => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = options.multiple !== false
      input.accept = (options.filters ?? []).flatMap(filter => filter.extensions).map(ext => `.${extension(ext)}`).join(',')
      input.setAttribute('aria-label', options.title || 'Choose files')
      input.style.display = 'none'

      let settled = false

      const finish = (paths: string[]) => {
        if (settled) {return}
        settled = true
        input.remove()
        resolve(paths)
      }

      input.addEventListener('change', () => finish([...input.files ?? []].map(register)), { once: true })
      window.addEventListener(
        'focus',
        () => window.setTimeout(() => {
          if (!input.files?.length) {finish([])}
        }, 300),
        { once: true }
      )
      document.body.append(input)
      input.click()
    })
  }

  const saveBuffer = async (data: ArrayBuffer | Uint8Array, ext: string): Promise<string> => {
    const normalized = extension(ext) || 'bin'
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)

    const file = new File([copy.buffer], `hermes-${crypto.randomUUID()}.${normalized}`, {
      type: mimeForExtension(normalized)
    })

    return register(file)
  }

  const saveClipboardImage = async (): Promise<string> => {
    if (!navigator.clipboard?.read) {return ''}

    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find(candidate => candidate.startsWith('image/'))

      if (!type) {continue}
      const blob = await item.getType(type)
      const ext = type.split('/')[1] || 'png'

      return register(new File([blob], `clipboard.${ext}`, { type }))
    }

    return ''
  }

  return {
    getPathForFile: register,
    readDataUrl,
    readText: async path => {
      const file = requireFile(path)

      return { path, text: await file.text(), byteSize: file.size }
    },
    register,
    release: path => files.delete(path),
    saveBuffer,
    saveClipboardImage,
    selectPaths
  }
}
