import {
  type HermesPlugin,
  host,
  PALETTE_AREA,
  type PaletteContribution,
  type RouteContribution,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution
} from '@hermes/plugin-sdk'

import { bindOperationsApi } from './api'
import { OperationsPage } from './page'

const LOCALES = {
  en: {
    operations: {
      open: 'Operations: Open control room'
    }
  }
}

const plugin: HermesPlugin = {
  id: 'operations',
  name: 'Operations',
  description: 'Public control room for Hermes Bots, active work, Mailroom, meetings, workspaces, Forge, and Training.',
  defaultEnabled: true,
  register(ctx) {
    ctx.i18n.register(LOCALES)
    ctx.onDispose(bindOperationsApi(ctx.rest))

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/operations' } satisfies RouteContribution,
        render: () => <OperationsPage />
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
      }
    ])
  }
}

export default plugin
