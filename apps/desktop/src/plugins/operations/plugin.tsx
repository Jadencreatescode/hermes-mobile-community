import {
  BOTS_ROSTER_PROVIDERS_AREA,
  type HermesPlugin,
  host,
  PALETTE_AREA,
  type PaletteContribution,
  type RouteContribution,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useState } from 'react'

import { bindOperationsApi } from './api'
import { a2aBotRosterProvider, disposeA2ABotWorkspaces } from './bot-roster-provider'
import { OperationsPage } from './page'

const LOCALES = {
  en: {
    operations: {
      open: 'Operations: Open control room'
    }
  }
}

export function routeRequestsOnboarding(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  const query = window.location.hash.split('?', 2)[1] ?? ''

  return new URLSearchParams(query).get('onboard') === '1'
}

export function OperationsRoute() {
  const [onboardingOpen, setOnboardingOpen] = useState(routeRequestsOnboarding)

  useEffect(() => {
    const syncRoute = () => setOnboardingOpen(routeRequestsOnboarding())

    window.addEventListener('hashchange', syncRoute)

    return () => window.removeEventListener('hashchange', syncRoute)
  }, [])

  const setOpen = useCallback((open: boolean) => {
    setOnboardingOpen(open)

    if (!open && routeRequestsOnboarding()) {
      host.navigate('/operations')
    }
  }, [])

  return <OperationsPage onboardingOpen={onboardingOpen} onOnboardingOpenChange={setOpen} />
}

const plugin: HermesPlugin = {
  id: 'operations',
  name: 'Operations',
  description: 'Public control room for Hermes Bots, active work, Mailroom, meetings, workspaces, and Forge.',
  defaultEnabled: true,
  register(ctx) {
    ctx.i18n.register(LOCALES)
    ctx.onDispose(bindOperationsApi(ctx.rest))
    ctx.onDispose(disposeA2ABotWorkspaces)

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/operations' } satisfies RouteContribution,
        render: () => <OperationsRoute />
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 45,
        data: { codicon: 'server-process', label: 'Operations', path: '/operations' } satisfies SidebarNavContribution
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'operations.open',
          label: 'Operations: Open control room',
          keywords: ['operations', 'agents', 'bots', 'work', 'mailroom', 'meetings', 'forge', 'kanban'],
          run: () => host.navigate('/operations')
        } satisfies PaletteContribution
      },
      {
        id: 'verified-a2a-agents',
        area: BOTS_ROSTER_PROVIDERS_AREA,
        data: a2aBotRosterProvider
      }
    ])
  }
}

export default plugin
