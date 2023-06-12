import {
  createContext,
  ReactElement,
  useContext
} from 'react'

import { useNostrStore } from './hooks/useNostr.js'
import { DEFAULT }       from './schema/config.js'
import { ProviderProps } from './schema/types.js'

export * from './schema/types.js'

export type NostrContext = ReturnType<typeof useNostrStore>

// Create our provider context.
const context = createContext<NostrContext | null>(null)

export function NostrProvider (
  { children, defaults = {} } : ProviderProps
) : ReactElement {
  // Returns the Provider that wraps our app and
  // passes down the context object.
  const ctx = useNostrStore({ ...DEFAULT.store, ...defaults })

  return (
    <context.Provider value={ctx}>
      {children}
    </context.Provider>
  )
}

export function useNostr () {
  const ctx = useContext(context)
  if (ctx === null) {
    throw new Error('Context is null!')
  }
  return ctx
}
