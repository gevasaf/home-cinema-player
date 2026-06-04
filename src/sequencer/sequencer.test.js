import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSequencer, STATES } from './sequencer.js'

const PLAYLIST = {
  weekOf: '2026-06-07',
  lobbyVideo: 'local://assets/lobby-loop.mp4',
  openingIdent: 'local://assets/ident.mp4',
  trailers: [
    { type: 'youtube', ytId: 'abc', title: 'Trailer 1' },
    { type: 'youtube', ytId: 'def', title: 'Trailer 2' },
  ],
  short: { type: 'torrent', imdbId: 'tt0000001', title: 'Short' },
  featureBumper: 'local://assets/feature-presentation.mp4',
  feature: { type: 'torrent', imdbId: 'tt0468569', title: 'The Dark Knight' },
  completedAt: null,
}

function makeResolvers(overrides = {}) {
  return {
    resolveLocal: vi.fn(async (uri) => `/local/${uri}`),
    resolveYoutube: vi.fn(async (id) => `https://yt.stream/${id}`),
    resolveDebrid: vi.fn(async (imdb) => `https://debrid.stream/${imdb}`),
    fetchSubtitles: vi.fn(async () => 'WEBVTT\n\n'),
    onStateChange: vi.fn(),
    onComplete: vi.fn(),
    ...overrides,
  }
}

describe('sequencer state machine', () => {
  let resolvers
  let seq
  let states

  beforeEach(() => {
    resolvers = makeResolvers()
    states = []
    resolvers.onStateChange = vi.fn((ctx) => states.push(ctx.state))
    seq = createSequencer(resolvers)
  })

  it('starts in LOBBY after loadPlaylist', async () => {
    await seq.loadPlaylist(PLAYLIST)
    const ctx = seq.getContext()
    expect(ctx.state).toBe(STATES.LOBBY)
    expect(ctx.streamUrl).toBe('/local/local://assets/lobby-loop.mp4')
  })

  it('moves to COMING_UP on start()', async () => {
    await seq.loadPlaylist(PLAYLIST)
    await seq.start()
    expect(seq.getContext().state).toBe(STATES.COMING_UP)
  })

  it('COMING_UP has no stream URL (poster overlay only)', async () => {
    await seq.loadPlaylist(PLAYLIST)
    await seq.start()
    expect(seq.getContext().streamUrl).toBeNull()
  })

  it('advances through full sequence', async () => {
    await seq.loadPlaylist(PLAYLIST)
    await seq.start()       // → COMING_UP
    await seq.advance()     // → IDENT
    await seq.advance()     // → TRAILERS (trailer 0)
    await seq.advance()     // → TRAILERS (trailer 1)
    await seq.advance()     // → SHORT
    await seq.advance()     // → BUMPER
    await seq.advance()     // → FEATURE
    await seq.advance()     // → CREDITS

    expect(seq.getContext().state).toBe(STATES.CREDITS)
  })

  it('plays each trailer in sequence before advancing past TRAILERS', async () => {
    await seq.loadPlaylist(PLAYLIST)
    await seq.start()
    await seq.advance() // IDENT
    await seq.advance() // TRAILERS trailer[0]

    expect(seq.getContext().trailerIndex).toBe(0)
    expect(resolvers.resolveYoutube).toHaveBeenCalledWith('abc')

    await seq.advance() // TRAILERS trailer[1]
    expect(seq.getContext().trailerIndex).toBe(1)
    expect(resolvers.resolveYoutube).toHaveBeenCalledWith('def')

    await seq.advance() // SHORT
    expect(seq.getContext().state).toBe(STATES.SHORT)
  })

  it('calls onComplete with playlist when FEATURE advances', async () => {
    await seq.loadPlaylist(PLAYLIST)
    await seq.start()
    await seq.advance() // IDENT
    await seq.advance() // TRAILERS[0]
    await seq.advance() // TRAILERS[1]
    await seq.advance() // SHORT
    await seq.advance() // BUMPER
    await seq.advance() // FEATURE
    await seq.advance() // CREDITS — triggers onComplete

    expect(resolvers.onComplete).toHaveBeenCalledWith(PLAYLIST)
  })

  it('FEATURE state fetches subtitles alongside stream', async () => {
    await seq.loadPlaylist(PLAYLIST)
    await seq.start()
    await seq.advance() // IDENT
    await seq.advance() // TRAILERS[0]
    await seq.advance() // TRAILERS[1]
    await seq.advance() // SHORT
    await seq.advance() // BUMPER
    await seq.advance() // FEATURE

    expect(resolvers.fetchSubtitles).toHaveBeenCalledWith('tt0468569', null)
    expect(seq.getContext().subtitleVtt).toBe('WEBVTT\n\n')
  })

  it('FEATURE continues if subtitle fetch fails', async () => {
    resolvers.fetchSubtitles = vi.fn(async () => { throw new Error('no subs') })
    seq = createSequencer(resolvers)
    await seq.loadPlaylist(PLAYLIST)
    await seq.start()
    await seq.advance()
    await seq.advance()
    await seq.advance()
    await seq.advance()
    await seq.advance()
    await seq.advance() // FEATURE

    const ctx = seq.getContext()
    expect(ctx.state).toBe(STATES.FEATURE)
    expect(ctx.subtitleVtt).toBeNull()
    expect(ctx.streamUrl).toBeTruthy()
  })

  it('captures error state when resolver throws', async () => {
    resolvers.resolveDebrid = vi.fn(async () => { throw new Error('debrid offline') })
    seq = createSequencer(resolvers)
    await seq.loadPlaylist(PLAYLIST)
    await seq.start()
    await seq.advance() // IDENT
    await seq.advance() // TRAILERS[0]
    await seq.advance() // TRAILERS[1]
    await seq.advance() // SHORT — debrid fails

    const ctx = seq.getContext()
    expect(ctx.error).toBe('debrid offline')
    expect(ctx.loading).toBe(false)
  })

  it('does not advance past CREDITS', async () => {
    await seq.loadPlaylist(PLAYLIST)
    // fast-forward to CREDITS
    for (let i = 0; i < 10; i++) {
      await seq.advance()
    }
    expect(seq.getContext().state).toBe(STATES.CREDITS)
  })
})
