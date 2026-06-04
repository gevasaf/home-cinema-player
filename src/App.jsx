import { useEffect, useRef, useCallback, useReducer } from 'react'
import { init, setFocus } from '@noriginmedia/norigin-spatial-navigation'
import ShakaPlayer from './player/ShakaPlayer.jsx'
import { store } from './store/ipc-store.js'
import { createSequencer, STATES } from './sequencer/sequencer.js'

init({
  debug: false,
  visualDebug: false,
  distanceCalculationMethod: 'center',
})

// Resolvers that delegate to the main process via IPC
const resolvers = {
  resolveLocal: async (uri) => {
    // local:// URIs point to bundled assets; in Electron we strip the protocol
    // and let the renderer load them relative to the app root.
    return uri.replace('local://', '')
  },
  resolveYoutube: (ytIdOrUrl) => window.cinema.ytdlp.resolve(ytIdOrUrl),
  resolveDebrid: (imdbId) => window.cinema.debrid.resolve(imdbId),
  fetchSubtitles: (imdbId, lang) => window.cinema.subtitles.fetch(imdbId, lang),
  onStateChange: () => {}, // replaced below
  onComplete: async (playlist) => {
    const history = (await store.get('playlistHistory')) || []
    const record = buildHistoryRecord(playlist)
    await store.set('playlistHistory', [...history, record])
    // Mark current playlist complete
    const current = (await store.get('currentPlaylist')) || playlist
    await store.set('currentPlaylist', { ...current, completedAt: new Date().toISOString() })
  },
}

function buildHistoryRecord(playlist) {
  return {
    weekOf: playlist.weekOf,
    completedAt: new Date().toISOString(),
    feature: {
      title: playlist.feature.title,
      imdbId: playlist.feature.imdbId,
      tmdbId: playlist.feature.tmdbId,
    },
    short: {
      title: playlist.short.title,
      imdbId: playlist.short.imdbId,
    },
    trailers: playlist.trailers,
    debridService: 'real-debrid', // resolved from storage in real impl
  }
}

function seqReducer(_state, action) {
  return action
}

export default function App() {
  const playerRef = useRef(null)
  const seqRef = useRef(null)
  const [seqCtx, dispatch] = useReducer(seqReducer, {
    state: STATES.LOBBY,
    playlist: null,
    streamUrl: null,
    subtitleVtt: null,
    loading: false,
    error: null,
    trailerIndex: 0,
  })

  const handleStateChange = useCallback((ctx) => {
    dispatch(ctx)
  }, [])

  useEffect(() => {
    resolvers.onStateChange = handleStateChange

    const seq = createSequencer(resolvers)
    seqRef.current = seq

    store.get('currentPlaylist').then((playlist) => {
      if (playlist) seq.loadPlaylist(playlist)
    })
  }, [handleStateChange])

  // Keyboard / D-pad handler
  useEffect(() => {
    function handleKey(e) {
      const seq = seqRef.current
      if (!seq) return

      if (e.key === 'Enter' || e.key === ' ') {
        const state = seqRef.current?.getContext().state
        if (state === STATES.LOBBY) {
          seq.start()
        }
      }
      if (e.key === 'ArrowRight' || e.key === 'MediaTrackNext') {
        seq.advance()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  const handleVideoEnded = useCallback(() => {
    seqRef.current?.advance()
  }, [])

  const isComingUp = seqCtx.state === STATES.COMING_UP

  return (
    <div className="relative w-screen h-screen bg-black overflow-hidden">
      {/* Video layer */}
      <div className="absolute inset-0">
        <ShakaPlayer
          ref={playerRef}
          streamUrl={seqCtx.streamUrl}
          subtitleVtt={seqCtx.subtitleVtt}
          autoPlay
        />
        {/* Wire ended event via the video element directly */}
        <VideoEndedListener onEnded={handleVideoEnded} playerRef={playerRef} />
      </div>

      {/* COMING_UP overlay — poster + title */}
      {isComingUp && seqCtx.playlist && (
        <ComingUpOverlay playlist={seqCtx.playlist} onDone={() => seqRef.current?.advance()} />
      )}

      {/* LOBBY overlay — Start prompt */}
      {seqCtx.state === STATES.LOBBY && !seqCtx.loading && (
        <div className="absolute bottom-12 left-0 right-0 flex justify-center">
          <p className="text-white text-2xl font-cinema animate-pulse">
            Press Enter to begin
          </p>
        </div>
      )}

      {/* Loading indicator */}
      {seqCtx.loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="text-white text-xl">Loading…</div>
        </div>
      )}

      {/* Error display */}
      {seqCtx.error && (
        <div className="absolute bottom-4 left-4 right-4 bg-red-900/80 text-white p-4 rounded">
          <strong>Error ({seqCtx.state}):</strong> {seqCtx.error}
        </div>
      )}

      {/* State debug badge — remove in Phase 3 */}
      <div className="absolute top-2 right-2 flex items-center gap-2 bg-black/50 text-white text-xs px-2 py-1 rounded font-mono">
        {seqCtx.state}
        {seqCtx.state === STATES.TRAILERS && ` [${seqCtx.trailerIndex + 1}/${seqCtx.playlist?.trailers?.length ?? 0}]`}
        <button
          onClick={() => seqRef.current?.advance()}
          className="bg-white/20 hover:bg-white/40 text-white px-1.5 py-0.5 rounded text-xs leading-none"
          title="Skip to next state"
        >
          ⏭
        </button>
      </div>
    </div>
  )
}

// Attaches ended listener to the underlying <video> element
function VideoEndedListener({ onEnded, playerRef }) {
  useEffect(() => {
    const video = playerRef.current
    if (!video) return
    // playerRef exposes our imperative handle, not the <video> element directly.
    // The ShakaPlayer renders into a <video> we can't grab from outside.
    // We use event delegation on the document instead.
    function handleEnded(e) {
      if (e.target.tagName === 'VIDEO') onEnded()
    }
    document.addEventListener('ended', handleEnded, true)
    return () => document.removeEventListener('ended', handleEnded, true)
  }, [onEnded, playerRef])
  return null
}

function ComingUpOverlay({ playlist, onDone }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 15000) // auto-advance after 15s
    return () => clearTimeout(timer)
  }, [onDone])

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80">
      <p className="text-amber-400 text-lg uppercase tracking-widest mb-4 font-cinema">
        Coming Up Tonight
      </p>
      <h1 className="text-white text-5xl font-cinema font-bold text-center px-8">
        {playlist.feature.title}
      </h1>
    </div>
  )
}
