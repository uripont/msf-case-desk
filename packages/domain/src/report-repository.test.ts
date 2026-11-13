import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  MAX_QUERIES_PER_REQUEST,
  QUERY_BUDGET,
  base64DecodedLength,
  imageChunkProblem,
} from './report-repository'
import {
  type MemorySession,
  makeMemoryReportRepository,
} from './testing/report-repository-memory'
import { reportRepositoryContract } from './testing/reportRepositoryContract'

reportRepositoryContract('in-memory', async options => {
  const sessions: Array<MemorySession> = []
  const repository = await Effect.runPromise(
    makeMemoryReportRepository({
      sessions,
      ...(options?.initialImageBytes === undefined
        ? {}
        : { initialImageBytes: options.initialImageBytes }),
    }),
  )
  return {
    repository,
    seedSession: async (tokenHash, userId) => {
      sessions.push({ tokenHash, userId })
    },
    countSessions: async userId =>
      sessions.filter(session => session.userId === userId).length,
  }
})

describe('report repository helpers', () => {
  test('every operation states a query budget within the Free limit', () => {
    for (const [operation, budget] of Object.entries(QUERY_BUDGET)) {
      expect(budget, operation).toBeGreaterThanOrEqual(1)
      expect(budget, operation).toBeLessThanOrEqual(MAX_QUERIES_PER_REQUEST)
    }
  })

  test('base64 lengths are read from the text', () => {
    expect(base64DecodedLength('AAAA')).toBe(3)
    expect(base64DecodedLength('AAA=')).toBe(2)
    expect(base64DecodedLength('AA==')).toBe(1)
  })

  test('a chunk that cannot belong to its image is a problem', () => {
    const base = {
      imageId: 'i',
      owner: { kind: 'theme' } as const,
      uploadedBy: 'u',
      mime: 'image/png' as const,
      width: 1,
      height: 1,
      size: 3,
      hash: 'h',
      chunkCount: 1,
      index: 0,
      data: 'AAAA',
      now: 0,
    }
    expect(imageChunkProblem(base)).toBeNull()
    expect(imageChunkProblem({ ...base, data: 'AAA=' })).toBe('length')
    expect(imageChunkProblem({ ...base, index: 1 })).toBe('index')
    expect(imageChunkProblem({ ...base, data: 'A*AA' })).toBe('encoding')
  })
})
