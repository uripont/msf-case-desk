import { describe, expect, test } from 'vitest'

import * as domain from './index'

describe('the package index', () => {
  test('exports no in-memory repository: those are tests only (`@quoroom/domain/testing/memory`)', () => {
    const names = Object.keys(domain).filter(name =>
      /^(makeMemory|layerMemory)/.test(name),
    )
    expect(names).toEqual([])
  })
})
