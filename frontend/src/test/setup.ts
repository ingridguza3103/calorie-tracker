import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
