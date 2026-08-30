import type { PluginRestOptions } from '@hermes/plugin-sdk'

type Rest = <T>(path: string, options?: PluginRestOptions) => Promise<T>

let rest: null | Rest = null

export function bindOperationsApi(next: Rest): () => void {
  rest = next

  return () => {
    if (rest === next) {
      rest = null
    }
  }
}

export function operationsApi(): Rest {
  if (!rest) {
    throw new Error('Operations API is unavailable. Update Hermes and try again.')
  }

  return rest
}
