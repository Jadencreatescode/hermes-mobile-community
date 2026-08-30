import { Button } from '@hermes/plugin-sdk'

export const OPERATIONS_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'mailroom', label: 'Mailroom' },
  { id: 'meetings', label: 'Meetings' },
  { id: 'workspace', label: 'Agent Workspace' },
  { id: 'training', label: 'Training' }
] as const

export type OperationsSection = (typeof OPERATIONS_SECTIONS)[number]['id']

export function OperationsNavigation({
  active,
  onChange
}: {
  active: OperationsSection
  onChange: (section: OperationsSection) => void
}) {
  return (
    <nav
      aria-label="Operations navigation"
      className="min-w-0 shrink-0 border-b border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) md:w-48 md:border-r md:border-b-0"
    >
      <label className="block p-2 md:hidden">
        <span className="sr-only">Operations section</span>
        <select
          aria-label="Operations section"
          className="min-h-11 w-full min-w-0 border border-(--ui-stroke-tertiary) bg-(--ui-bg-primary) px-3 text-sm text-(--ui-text-primary) outline-none focus-visible:ring-2 focus-visible:ring-(--ui-accent)"
          onChange={event => onChange(event.target.value as OperationsSection)}
          value={active}
        >
          {OPERATIONS_SECTIONS.map(section => (
            <option key={section.id} value={section.id}>{section.label}</option>
          ))}
        </select>
      </label>
      <div aria-label="Operations sections" className="hidden min-w-0 flex-col gap-1 p-2 md:flex" role="tablist">
        {OPERATIONS_SECTIONS.map(section => (
          <Button
            aria-selected={active === section.id}
            className="min-h-11 w-full"
            key={section.id}
            onClick={() => onChange(section.id)}
            role="tab"
            size="sm"
            variant={active === section.id ? 'secondary' : 'ghost'}
          >
            <span className="w-full truncate text-left">{section.label}</span>
          </Button>
        ))}
      </div>
    </nav>
  )
}
