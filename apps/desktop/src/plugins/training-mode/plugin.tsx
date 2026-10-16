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

import { bindTrainingApi } from './api'
import { TrainingModePage } from './page'

const plugin: HermesPlugin = {
  id: 'training-mode',
  name: 'Training Mode',
  description: 'Teach Hermes reusable tasks through a review-first guided conversation.',
  defaultEnabled: true,
  register(ctx) {
    ctx.onDispose(bindTrainingApi(ctx.rest))
    const open = () => host.navigate('/training')

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/training' } satisfies RouteContribution,
        render: () => <TrainingModePage />
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 55,
        data: { codicon: 'mortar-board', label: 'Training', path: '/training' } satisfies SidebarNavContribution
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'training-mode.open',
          label: 'Training Mode: Teach Hermes a task',
          keywords: ['training', 'teach', 'learn', 'skill', 'workflow'],
          run: open
        } satisfies PaletteContribution
      }
    ])
  }
}

export default plugin
