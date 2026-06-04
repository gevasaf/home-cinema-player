const http = require('http')
const { spawn, execFile } = require('child_process')
const { app } = require('electron')
const path = require('path')

let server = null
let port = null

function getFfmpegPath() {
  if (app.isPackaged) {
    const ext = process.platform === 'win32' ? '.exe' : ''
    return path.join(process.resourcesPath, 'assets', `ffmpeg${ext}`)
  }
  return require('ffmpeg-static')
}

// Probe the video codec by running ffmpeg -i and parsing stderr.
// Returns a codec name like 'h264', 'hevc', 'av1', etc., or null on failure.
function probeVideoCodec(ffmpeg, url) {
  return new Promise((resolve) => {
    execFile(ffmpeg, ['-hide_banner', '-i', url], { timeout: 15000 }, (_err, _stdout, stderr) => {
      const match = stderr.match(/Video:\s+(\w+)/)
      resolve(match ? match[1].toLowerCase() : null)
    })
  })
}

// Codecs Electron's Chromium can play natively in an fMP4 container
const CHROMIUM_NATIVE_CODECS = new Set(['h264', 'avc', 'avc1', 'vp8', 'vp9'])

function startTranscodeProxy() {
  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      const parsedUrl = new URL(req.url, `http://localhost`)
      const targetUrl = parsedUrl.searchParams.get('url')
      if (!targetUrl) {
        res.writeHead(400)
        res.end('Missing url param')
        return
      }
      const ffmpeg = getFfmpegPath()

      const codec = await probeVideoCodec(ffmpeg, targetUrl)
      console.log(`[transcodeProxy] detected video codec: ${codec ?? 'unknown'}`)

      // Electron's Chromium can't decode HEVC/AV1 natively — transcode those to H.264.
      // H.264 sources are copied as-is to avoid unnecessary CPU cost.
      const needsTranscode = !codec || !CHROMIUM_NATIVE_CODECS.has(codec)
      const videoArgs = needsTranscode
        ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18']
        : ['-c:v', 'copy']

      if (needsTranscode && codec) {
        console.log(`[transcodeProxy] transcoding ${codec} → H.264`)
      }

      const audioTrack = parseInt(parsedUrl.searchParams.get('audio') || '0', 10)

      const proc = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-analyzeduration', '10M', '-probesize', '50M',
        '-i', targetUrl,
        '-map', '0:v:0',
        `-map`, `0:a:${audioTrack}`,
        ...videoArgs,
        '-c:a', 'aac',
        '-b:a', '192k',
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+faststart',
        'pipe:1',
      ])

      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      })

      proc.stdout.pipe(res)

      proc.stderr.on('data', (d) => console.error('[ffmpeg]', d.toString()))

      req.on('close', () => proc.kill())
      proc.on('error', (err) => {
        console.error('[transcodeProxy] ffmpeg error:', err)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    })

    server.listen(0, '127.0.0.1', () => {
      port = server.address().port
      console.log(`[transcodeProxy] listening on port ${port}`)
      resolve(port)
    })

    server.on('error', reject)
  })
}

function stopTranscodeProxy() {
  if (server) server.close()
}

function proxyUrl(debridUrl, audioTrack = 0) {
  if (!port) throw new Error('Transcode proxy not started')
  const audio = Number.isInteger(audioTrack) && audioTrack > 0 ? `&audio=${audioTrack}` : ''
  return `http://127.0.0.1:${port}/?url=${encodeURIComponent(debridUrl)}${audio}`
}

module.exports = { startTranscodeProxy, stopTranscodeProxy, proxyUrl }
