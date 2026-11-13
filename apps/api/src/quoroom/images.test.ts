import { afterEach, describe, expect, test } from 'vitest'

import { SCENARIOS, TEXT, type PersonName, type World, makeWorld, richContent, withFigure } from './testkit'
import { exifSegment, makeJpeg, makePng, pngChunk, pngIhdr, pngSignature } from './imageFixtures'

// NOTE: The `/api/images` route (stage 4 review): what an upload may carry,
// and which version an image is read through. Synthetic pictures built by hand.

const worlds: Array<World> = []
afterEach(async () => {
  await Promise.all(worlds.splice(0).map(world => world.dispose()))
})

const ascii = (text: string) => [...text].map(c => c.charCodeAt(0))

describe.each(SCENARIOS)('$name', scenario => {
  const world = async () => {
    const made = await makeWorld(scenario)
    worlds.push(made)
    return made
  }

  const upload = (
    w: World,
    who: PersonName,
    reportId: string,
    id: string,
    bytes: Uint8Array,
    mime = bytes[0] === 0xff ? 'image/jpeg' : 'image/png',
  ) => {
    const chunks = Math.ceil(bytes.length / 700_000)
    const send = (index: number) =>
      w.raw(
        who,
        `/api/images?uploadId=${id}&owner=${reportId}&index=${index}&chunks=${chunks}&mime=${encodeURIComponent(mime)}&width=1&height=1&size=${bytes.length}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: bytes.slice(index * 700_000, (index + 1) * 700_000),
        },
      )
    return Array.from({ length: chunks }, (_, index) => index).reduce<Promise<Response>>(
      (previous, index) => previous.then(() => send(index)),
      Promise.resolve(new Response()),
    )
  }

  const code = async (response: Response) => ((await response.json()) as { code?: string }).code

  describe('metadata', () => {
    test('a clean JPEG and a clean PNG are accepted', async () => {
      const w = await world()
      const reportId = await w.createReport()
      expect((await upload(w, 'alice', reportId, 'img-jpeg', makeJpeg())).status).toBe(200)
      expect((await upload(w, 'alice', reportId, 'img-png', makePng())).status).toBe(200)
    })

    test('a JPEG with EXIF or XMP (APP1) is refused and not kept', async () => {
      const w = await world()
      const reportId = await w.createReport()
      const response = await upload(w, 'alice', reportId, 'img-exif', makeJpeg([exifSegment]))
      expect(response.status).toBe(415)
      expect(await code(response)).toBe('has_metadata')
      const xmp = [0xff, 0xe1, 0, 8, ...ascii('http'), 0, 0].slice(0, 10)
      expect(await code(await upload(w, 'alice', reportId, 'img-xmp', makeJpeg([xmp])))).toBe('has_metadata')
      expect((await w.raw('alice', `/api/images/img-exif/0?report=${reportId}&context=working_copy`)).status).toBe(404)
    })

    test.each(['tEXt', 'zTXt', 'iTXt', 'eXIf'])('a PNG with a %s chunk is refused', async type => {
      const w = await world()
      const reportId = await w.createReport()
      const response = await upload(w, 'alice', reportId, 'img-meta', makePng([pngChunk(type, ascii('Comment\0secret'))]))
      expect(response.status).toBe(415)
      expect(await code(response)).toBe('has_metadata')
    })

    test('metadata is found when it starts in one chunk and ends in the next', async () => {
      const w = await world()
      const reportId = await w.createReport()
      // NOTE: the chunk type "tEXt" is cut between "tE" and "Xt" at the
      // 700000-byte boundary of the first of two chunks.
      const filler = 700_000 - (pngSignature.length + pngIhdr.length + 12 + 4 + 2)
      const bytes = makePng([pngChunk('tEXt', ascii('Author\0someone'))], filler)
      expect(String.fromCharCode(...bytes.slice(699_998, 700_002))).toBe('tEXt')
      const response = await upload(w, 'alice', reportId, 'img-split', bytes)
      expect(response.status).toBe(415)
      expect(await code(response)).toBe('has_metadata')
      // NOTE: the same two-chunk image without the text chunk is accepted.
      const clean = makePng([], 700_100)
      expect((await upload(w, 'alice', reportId, 'img-split-clean', clean)).status).toBe(200)
    })

    test('another format is refused: a GIF named as JPEG by its signature, a WebP by its type', async () => {
      const w = await world()
      const reportId = await w.createReport()
      const gif = new Uint8Array([...ascii('GIF89a'), 1, 0, 1, 0, 0, 0, 0, 0x3b])
      const response = await upload(w, 'alice', reportId, 'img-gif', gif, 'image/jpeg')
      expect(response.status).toBe(415)
      expect(await code(response)).toBe('bad_signature')
      const webp = new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')])
      expect((await upload(w, 'alice', reportId, 'img-webp', webp, 'image/webp')).status).toBe(400)
    })
  })

  describe('reading through a version', () => {
    const setup = async () => {
      const w = await world()
      const reportId = await w.createReport()
      await w.call('alice', c => c.AddCoAuthor({ reportId, accountId: 'bob' }))
      expect((await upload(w, 'alice', reportId, 'img-used', makePng())).status).toBe(200)
      expect((await upload(w, 'alice', reportId, 'img-loose', makePng([], 30))).status).toBe(200)
      const shared = await w.share('alice', reportId, {
        shareId: 'share-1',
        content: withFigure(scenario.itemId, TEXT, 'img-used', false) as unknown as ReturnType<typeof richContent>,
      })
      if (shared.outcome.kind !== 'shared') throw new Error('not shared')
      const published = await w.publish('alice', reportId, shared.outcome.draft.number)
      const read = (who: PersonName, id: string, context: string) =>
        w.raw(who, `/api/images/${id}/0?report=${reportId}&${context}`).then(response => response.status)
      return { w, reportId, draft: shared.outcome.draft.number, revision: (published.revision as unknown as { number: number }).number, read }
    }

    test('through a draft that references it, and not through one that does not', async () => {
      const { draft, read } = await setup()
      expect(await read('alice', 'img-used', `context=draft&draft=${draft}`)).toBe(200)
      expect(await read('alice', 'img-loose', `context=draft&draft=${draft}`)).toBe(404)
      expect(await read('alice', 'img-used', 'context=draft&draft=99')).toBe(404)
    })

    test('a co-author reads the draft, a non-author and a reviewer do not', async () => {
      const { draft, read } = await setup()
      expect(await read('bob', 'img-used', `context=draft&draft=${draft}`)).toBe(200)
      expect(await read('frank', 'img-used', `context=draft&draft=${draft}`)).toBe(404)
      expect(await read('carol', 'img-used', `context=draft&draft=${draft}`)).toBe(404)
    })

    test('the working copy needs the permission: an account outside the drafting role gets nothing', async () => {
      const { read } = await setup()
      expect(await read('alice', 'img-used', 'context=working_copy')).toBe(200)
      expect(await read('frank', 'img-used', 'context=working_copy')).toBe(404)
      expect(await read('carol', 'img-used', 'context=working_copy')).toBe(404)
    })

    test('through a revision: only a participant that may read it, and only an image it references', async () => {
      const { revision, read } = await setup()
      expect(await read('frank', 'img-used', `context=revision&revision=${revision}`)).toBe(404)
      expect(await read('alice', 'img-loose', `context=revision&revision=${revision}`)).toBe(404)
      expect(await read('alice', 'img-used', `context=revision&revision=${revision + 5}`)).toBe(404)
      if (scenario.fullRole !== undefined) {
        expect(await read('erin', 'img-used', `context=revision&revision=${revision}`)).toBe(200)
        expect(await read('erin', 'img-loose', `context=revision&revision=${revision}`)).toBe(404)
      }
    })

    test('missing parameters answer the same for an image that exists and one that does not', async () => {
      const { w, reportId, revision } = await setup()
      const queries = [
        'context=working_copy',
        'context=draft',
        'context=revision',
        `report=${reportId}&context=draft`,
        `report=${reportId}&context=revision`,
        `context=revision&revision=${revision}`,
      ]
      for (const query of queries) {
        const known = await w.raw('alice', `/api/images/img-used/0?${query}`)
        const unknown = await w.raw('alice', `/api/images/img-nothing/0?${query}`)
        expect(known.status, query).toBe(404)
        expect(unknown.status, query).toBe(404)
        expect(await known.json()).toEqual(await unknown.json())
      }
    })
  })
})
