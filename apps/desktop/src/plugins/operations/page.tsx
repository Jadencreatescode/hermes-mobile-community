import { host } from '@hermes/plugin-sdk'
import { useState } from 'react'

import { OperationsNavigation, type OperationsSection } from './navigation'

export function OperationsPage() {
  const [section, setSection] = useState<OperationsSection>('overview')

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="shrink-0 border-b border-(--ui-stroke-tertiary) px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <h1 className="text-lg font-semibold">Operations</h1>
        <p className="text-sm text-(--ui-text-secondary)">See and coordinate your Hermes Bots and their work.</p>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex-row">
        <OperationsNavigation active={section} onChange={setSection} />
        <section className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-4">
          <h2 className="text-base font-semibold">{section === 'training' ? 'Training' : 'Operations setup'}</h2>
          <p className="mt-2 max-w-xl text-sm text-(--ui-text-secondary)">
            {section === 'training'
              ? 'Use the public review first Training Mode to create reusable skills without running the task.'
              : 'This Operations surface is being connected to the existing Hermes profile, session, Kanban, and Bot authorities.'}
          </p>
          {section === 'training' && (
            <button className="mt-4 min-h-11 rounded-md border border-(--ui-stroke-secondary) px-4 text-sm" onClick={() => host.navigate('/training')} type="button">
              Open Training Mode
            </button>
          )}
        </section>
      </div>
    </main>
  )
}
