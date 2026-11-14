import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 as nodeCrc32 } from 'node:zlib'
import { expect, test } from 'vitest'

import { crc32, zipStore } from './zip'

const entries = [
  { name: 'case_intake_Draft-1.pdf', data: new TextEncoder().encode('first') },
  { name: 'folder/second.pdf', data: new Uint8Array(70_000).fill(7) },
  { name: 'empty.txt', data: new Uint8Array(0) },
]

test('the checksum is the standard CRC-32', () => {
  for (const { data } of entries) {
    expect(crc32(data)).toBe(nodeCrc32(data))
  }
})

test('the same entries and time give the same bytes', () => {
  const when = new Date('2026-11-12T10:20:30Z')
  expect(zipStore(entries, when)).toEqual(zipStore(entries, when))
})

test('a standard unzip lists, tests and extracts every entry', () => {
  const folder = mkdtempSync(join(tmpdir(), 'zip-test-'))
  const file = join(folder, 'out.zip')
  writeFileSync(file, zipStore(entries, new Date('2026-11-12T10:20:30Z')))
  const listing = spawnSync('unzip', ['-l', file], { encoding: 'utf8' })
  expect(listing.status).toBe(0)
  for (const entry of entries) {
    expect(listing.stdout).toContain(entry.name)
  }
  const tested = spawnSync('unzip', ['-t', file], { encoding: 'utf8' })
  expect(tested.status).toBe(0)
  expect(tested.stdout).toContain('No errors detected')
  const extracted = spawnSync('unzip', ['-p', file, 'case_intake_Draft-1.pdf'])
  expect(Buffer.from(extracted.stdout).toString()).toBe('first')
  expect(readFileSync(file).length).toBeGreaterThan(70_000)
})
