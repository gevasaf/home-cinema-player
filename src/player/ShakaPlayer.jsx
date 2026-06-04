import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react'

// Shaka Player is loaded as a side-effectful global in index.html (CDN UMD build).
// This avoids bundling issues with its large asset map.

/**
 * @param {{ streamUrl: string|null, subtitleVtt: string|null, autoPlay?: boolean }} props
 * @param ref — exposes { play(), pause(), seek(seconds) }
 */
const ShakaPlayer = forwardRef(function ShakaPlayer(
  { streamUrl, subtitleVtt, autoPlay = true },
  ref
) {
  const videoRef = useRef(null)
  const playerRef = useRef(null)

  useImperativeHandle(ref, () => ({
    play: () => videoRef.current?.play(),
    pause: () => videoRef.current?.pause(),
    seek: (seconds) => {
      if (videoRef.current) videoRef.current.currentTime = seconds
    },
    get currentTime() {
      return videoRef.current?.currentTime ?? 0
    },
    get duration() {
      return videoRef.current?.duration ?? 0
    },
  }))

  // Init Shaka once
  useEffect(() => {
    const video = videoRef.current
    if (!video || !window.shaka) return

    window.shaka.polyfill.installAll()
    if (!window.shaka.Player.isBrowserSupported()) {
      console.error('Shaka Player: browser not supported')
      return
    }

    const player = new window.shaka.Player(video)
    playerRef.current = player

    player.addEventListener('error', (event) => {
      console.error('Shaka error', event.detail)
    })

    return () => {
      player.destroy()
      playerRef.current = null
    }
  }, [])

  // Load new stream when URL changes
  useEffect(() => {
    const player = playerRef.current
    const video = videoRef.current
    if (!player || !streamUrl) return

    let cancelled = false

    // Use native <video src> for direct files (proxy streams, direct debrid URLs, YouTube MP4s).
    // Shaka is only needed for adaptive manifests (HLS .m3u8 / DASH .mpd).
    if (!/\.(m3u8|mpd)(\?|$)/i.test(streamUrl)) {
      player.unload().then(() => {
        if (cancelled) return
        video.src = streamUrl

        // Inject subtitles via <track> for native video path
        Array.from(video.querySelectorAll('track')).forEach(t => t.remove())
        if (subtitleVtt) {
          const blob = new Blob([subtitleVtt], { type: 'text/vtt' })
          const blobUrl = URL.createObjectURL(blob)
          const track = document.createElement('track')
          track.kind = 'subtitles'
          track.srclang = 'en'
          track.default = true
          track.src = blobUrl
          video.appendChild(track)
        }

        if (autoPlay) video.play().catch(() => {})
      })
      return () => {
        cancelled = true
        video.src = ''
      }
    }

    async function load() {
      try {
        await player.load(streamUrl)
        if (cancelled) return

        // Inject subtitle track if provided
        if (subtitleVtt) {
          const blob = new Blob([subtitleVtt], { type: 'text/vtt' })
          const url = URL.createObjectURL(blob)
          await player.addTextTrackAsync(url, 'en', 'subtitle', 'text/vtt')
          player.setTextTrackVisibility(true)
        }

        if (autoPlay) video.play().catch(() => {})
      } catch (err) {
        if (!cancelled) console.error('Shaka load error:', err)
      }
    }

    load()
    return () => { cancelled = true }
  }, [streamUrl, subtitleVtt, autoPlay])

  return (
    <video
      ref={videoRef}
      className="w-full h-full object-contain bg-black"
      playsInline
    />
  )
})

export default ShakaPlayer
