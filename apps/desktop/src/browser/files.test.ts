import { afterEach, describe, expect, it } from 'vitest'

import { BROWSER_ATTACHMENT_MAX_BYTES, createBrowserFileRegistry } from './files'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('browser file registry', () => {
  it('registers a phone-selected file and reads it back as text and a data URL', async () => {
    const registry = createBrowserFileRegistry()
    const file = new File(['hello phone'], 'notes.txt', { type: 'text/plain' })
    const path = registry.register(file)

    await expect(registry.readText(path)).resolves.toMatchObject({ path, text: 'hello phone', byteSize: 11 })
    await expect(registry.readDataUrl(path)).resolves.toBe('data:text/plain;base64,aGVsbG8gcGhvbmU=')
  })

  it('uses an image-aware browser picker and returns synthetic paths', async () => {
    const registry = createBrowserFileRegistry()

    const picked = registry.selectPaths({
      filters: [{ name: 'Images', extensions: ['png', 'jpg'] }],
      multiple: true,
      title: 'Attach images'
    })

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.accept).toBe('.png,.jpg')
    expect(input.multiple).toBe(true)

    const file = new File(['png-bytes'], 'photo.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change'))

    const paths = await picked
    expect(paths).toHaveLength(1)
    await expect(registry.readDataUrl(paths[0])).resolves.toMatch(/^data:image\/png;base64,/)
    expect(document.body.contains(input)).toBe(false)
  })

  it('stages generated image bytes for the existing attachment pipeline', async () => {
    const registry = createBrowserFileRegistry()
    const path = await registry.saveBuffer(new Uint8Array([1, 2, 3]), '.png')

    await expect(registry.readDataUrl(path)).resolves.toBe('data:image/png;base64,AQID')
  })

  it('rejects an oversized selected file before FileReader allocates a data URL', async () => {
    const registry = createBrowserFileRegistry()
    const file = new File(['small'], 'oversized.bin', { type: 'application/octet-stream' })
    Object.defineProperty(file, 'size', { value: BROWSER_ATTACHMENT_MAX_BYTES + 1 })
    const path = registry.register(file)

    await expect(registry.readDataUrl(path)).rejects.toThrow(
      `file is too large (${BROWSER_ATTACHMENT_MAX_BYTES + 1} bytes; limit ${BROWSER_ATTACHMENT_MAX_BYTES} bytes)`
    )
  })

  it('releases selected file bytes and fails closed on later reads', async () => {
    const registry = createBrowserFileRegistry()
    const path = registry.register(new File(['private bytes'], 'secret.txt', { type: 'text/plain' }))

    expect(registry.release(path)).toBe(true)
    expect(registry.release(path)).toBe(false)
    await expect(registry.readDataUrl(path)).rejects.toThrow(/no longer available/i)
  })
})
