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
 * @param {function(string): Promise<string>} resolvers.resolveYoutubeSubtitles  ytId/url → vtt
 * @param {function(string, number?): Promise<string>} resolvers.resolveDebrid  (imdbId, audioTrack?) → proxied stream url
 * @param {function(string, number?): Promise<string>} resolvers.proxyStreamUrl  (url, audioTrack?) → proxied stream url
 * @param {function(string, string): Promise<string>} resolvers.fetchSubtitles  (imdbId, lang) → vtt
 * @param {function(string): Promise<string>} resolvers.fetchSubtitleUrl  url → vtt
 * @param {function(Object): void} resolvers.onStateChange  called on every context change
 * @param {function(Object): void} resolvers.onComplete  called when FEATURE completes
 */
export function createSequencer(resolvers) {
  const {
    resolveLocal,
    resolveYoutube,
    resolveYoutubeSubtitles,
    resolveDebrid,
    proxyStreamUrl,
    fetchSubtitles,
    fetchSubtitleUrl,
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

  function shiftVtt(vtt, offsetSeconds) {
    if (!offsetSeconds) return vtt
    const shiftTime = (t) => {
      const [h, m, s] = t.split(':')
      const total = Math.max(0, parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s) + offsetSeconds)
      const oh = Math.floor(total / 3600)
      const om = Math.floor((total % 3600) / 60)
      const os = (total % 60).toFixed(3).padStart(6, '0')
      return `${String(oh).padStart(2, '0')}:${String(om).padStart(2, '0')}:${os}`
    }
    return vtt.replace(/([\d:]+\.[\d]+) --> ([\d:]+\.[\d]+)/g,
      (_, a, b) => `${shiftTime(a)} --> ${shiftTime(b)}`)
  }

  async function resolveItem(item) {
    if (item.type === 'youtube') {
      const [url, vtt] = await Promise.all([
        resolveYoutube(item.ytId),
        resolveYoutubeSubtitles(item.ytId).catch(() => null),
      ])
      return { url, vtt }
    }

    const [url, rawVtt] = await Promise.all([
      item.streamUrl
        ? proxyStreamUrl(item.streamUrl, item.audioTrack ?? 0)
        : resolveDebrid(item.imdbId, item.audioTrack ?? 0),
      item.subtitleOverride
        ? fetchSubtitleUrl(item.subtitleOverride).catch(() => null)
        : fetchSubtitles(item.imdbId, null).catch(() => null),
    ])
    const vtt = shiftVtt(rawVtt, item.subtitleOffset ?? 0)
    return { url, vtt }
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
        const [url, vtt] = await Promise.all([
          resolveYoutube(trailer.ytId),
          resolveYoutubeSubtitles(trailer.ytId).catch(() => null),
        ])
        return { url, vtt }
      }

      case STATES.SHORT:
        return resolveItem(pl.short)

      case STATES.BUMPER:
        return { url: await resolveLocal(pl.featureBumper), vtt: null }

      case STATES.FEATURE:
        return resolveItem(pl.feature)

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
