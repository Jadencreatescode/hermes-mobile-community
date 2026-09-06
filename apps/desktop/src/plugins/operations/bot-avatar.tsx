import { profileColor } from '@hermes/plugin-sdk'

export interface BotAvatarProps {
  name: string
  className?: string
  size?: 'sm' | 'md' | 'lg'
}

const SIZE_CLASSES: Record<string, string> = {
  sm: 'size-6 text-[0.625rem]',
  md: 'size-8 text-xs',
  lg: 'size-10 text-sm'
}

/**
 * Deterministic identity avatar for A2A and Operations bots.
 * PORT-AS-IS: presentational only; color derived from name hash.
 */
export function BotAvatar({ name, className, size = 'md' }: BotAvatarProps) {
  const color = profileColor(name) ?? 'var(--ui-text-tertiary)'
  const monogram = name.trim().slice(0, 2).toUpperCase()

  return (
    <span
      aria-label={name}
      className={`inline-grid shrink-0 place-items-center rounded-md font-medium ${SIZE_CLASSES[size] ?? SIZE_CLASSES.md} ${className ?? ''}`}
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)`,
        color
      }}
      title={name}
    >
      {monogram}
    </span>
  )
}
