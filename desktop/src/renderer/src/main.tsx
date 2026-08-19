import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider
} from '@tanstack/react-router'
import { Home } from './Home'
import { RigScreen } from './RigScreen'
import { initBridge } from './bridge'
import './index.css'

// Hash history: the packaged renderer is loaded from a file:// path, where a
// path-based history would never match '/'.
const rootRoute = createRootRoute()
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Home })
const rigRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/rig/$jetsonId',
  component: RigScreen
})
const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, rigRoute]),
  history: createHashHistory()
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const queryClient = new QueryClient()

// IPC push subscriptions are wired once, outside React (StrictMode-safe).
initBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
)
