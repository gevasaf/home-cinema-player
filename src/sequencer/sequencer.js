/**
 * Playback sequencer state machine.
 * Pure logic — no IPC, no DOM. Resolvers are injected so this module is testable.
 *
 * States: LOBBY → COMING_UP → IDENT → TRAILERS → SHORT → BUMPER → FEATURE → CREDITS
 */

export const STATES = /** @type {const} */ ({
  LOBBY: 'LOBBY',
  COMING_UP: 'COMING_UP',
  IDENT: 'IDENT',
  TRAILERS: 'TRAILERS',
  SHORT: 'SHORT',
  BUMPER: 'BUMPER',
  FEATURE: 'FEATURE',
  CREDITS: 'CREDITS',
})

const STATE_ORDER = [
  STATES.LOBBY,
  STATES.COMING_UP,
  STATES.IDENT,
  STATES.TRAILERS,
  STATES.SHORT,
  STATES.BUMPER,
  STATES.FEATURE,
  STATES.CREDITS,
]

/**
 * @typedef {Object} SequencerContext
 * @property {string} state
 * @property {Object|null} playlist
 * @property {number} trailerIndex   current trailer being played
 * @property {string|null} streamUrl resolved for current state
 * @property {string|null} subtitleVtt
 * @property {boolean} loading       true while resolving stream
 * @property {string|null} error
 */

/**
 * @param {Object} resolvers
 * @param {function(string): Promise<string>} resolvers.resolveLocal  local:// → file path
 * @param {function(string): Promise<string>} resolvers.resolveYoutube  ytId/url → stream url
 * @param {function(string): Promise<string>} resolvers.resolveDebrid  imdbId → stream url
 * @param {function(string, string): Promise<string>} resolvers.fetchSubtitles  (imdbId, lang) → vtt
 * @param {function(Object): void} resolvers.onStateChange  called on every context change
 * @param {function(Object): void} resolvers.onComplete  called when FEATURE completes
 */
export function createSequencer(resolvers) {
  const {
    resolveLocal,
    resolveYoutube,
    resolveDebrid,
    fetchSubtitles,
    onStateChange,
    onComplete,
  } = resolvers

  /** @type {SequencerContext} */
  let ctx = {
    state: STATES.LOBBY,
    playlist: null,
    trailerIndex: 0,
    streamUrl: null,
    subtitleVtt: null,
    loading: false,
    error: null,
  }

  function emit(patch) {
    ctx = { ...ctx, ...patch }
    onStateChange(ctx)
  }

  function currentTrailer() {
    return ctx.playlist?.trailers?.[ctx.trailerIndex] ?? null
  }

  async function resolveForState(state) {
    const pl = ctx.playlist
    if (!pl) throw new Error('No playlist loaded')

    switch (state) {
      case STATES.LOBBY:
        return { url: await resolveLocal(pl.lobbyVideo), vtt: null }

      case STATES.COMING_UP:
        // COMING_UP is a UI overlay (poster + title), not a video stream.
        // Return null so the player stays idle / shows the poster.
        return { url: null, vtt: null }

      case STATES.IDENT:
        return { url: await resolveLocal(pl.openingIdent), vtt: null }

      case STATES.TRAILERS: {
        const trailer = currentTrailer()
        if (!trailer) return { url: null, vtt: null }
        return { url: await resolveYoutube(trailer.ytId), vtt: null }
      }

      case STATES.SHORT: {
        const url = await resolveDebrid(pl.short.imdbId)
        return { url, vtt: null }
      }

      case STATES.BUMPER:
        return { url: await resolveLocal(pl.featureBumper), vtt: null }

      case STATES.FEATURE: {
        const [url, vtt] = await Promise.all([
          resolveDebrid(pl.feature.imdbId),
          fetchSubtitles(pl.feature.imdbId, null).catch(() => null),
        ])
        return { url, vtt }
      }

      case STATES.CREDITS:
        return { url: null, vtt: null }

      default:
        throw new Error(`Unknown state: ${state}`)
    }
  }

  async function enterState(state) {
    emit({ state, loading: true, error: null, streamUrl: null, subtitleVtt: null })
    try {
      const { url, vtt } = await resolveForState(state)
      emit({ loading: false, streamUrl: url, subtitleVtt: vtt })
    } catch (err) {
      emit({ loading: false, error: err.message })
    }
  }

  // Public API

  function loadPlaylist(playlist) {
    ctx = { ...ctx, playlist, trailerIndex: 0 }
    return enterState(STATES.LOBBY)
  }

  function start() {
    if (ctx.state !== STATES.LOBBY) return
    return enterState(STATES.COMING_UP)
  }

  async function advance() {
    const state = ctx.state

    // TRAILERS: step through each trailer before moving on
    if (state === STATES.TRAILERS) {
      const nextIndex = ctx.trailerIndex + 1
      if (nextIndex < (ctx.playlist?.trailers?.length ?? 0)) {
        emit({ trailerIndex: nextIndex })
        return enterState(STATES.TRAILERS)
      }
    }

    // FEATURE complete → write history, then go to CREDITS
    if (state === STATES.FEATURE) {
      onComplete(ctx.playlist)
    }

    const currentIndex = STATE_ORDER.indexOf(state)
    if (currentIndex === -1 || currentIndex === STATE_ORDER.length - 1) return
    const next = STATE_ORDER[currentIndex + 1]
    return enterState(next)
  }

  function getContext() {
    return ctx
  }

  return { loadPlaylist, start, advance, getContext }
}
