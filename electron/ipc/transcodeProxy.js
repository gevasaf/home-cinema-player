const http = require('http')
const { spawn } = require('child_process')
const { app } = require('electron')
const path = require('path')

let server = null
let port = null

function getFfmpegPath() {
  // In packaged app, ffmpeg-static is in extraResources; in dev, use node_modules
  if (app.isPackaged) {
    const ext = process.platform === 'win32' ? '.exe' : ''
    return path.join(process.resourcesPath, 'assets', `ffmpeg${ext}`)
  }
  return require('ffmpeg-static')
}

function startTranscodeProxy() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://localhost`)
      const targetUrl = parsedUrl.searchParams.get('url')
      if (!targetUrl) {
        res.writeHead(400)
        res.end('Missing url param')
        return
      }

      const ffmpeg = getFfmpegPath()
      // Copy video as-is; transcode audio to AAC (handles AC3, DTS, TrueHD, etc.)
      const proc = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-analyzeduration', '10M', '-probesize', '50M',
        '-i', targetUrl,
        '-map', '0:v:0',
        '-map', '0:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-f', 'matroska',
        'pipe:1',
      ])

      res.writeHead(200, {
        'Content-Type': 'video/x-matroska',
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

function proxyUrl(debridUrl) {
  if (!port) throw new Error('Transcode proxy not started')
  return `http://127.0.0.1:${port}/?url=${encodeURIComponent(debridUrl)}`
}

module.exports = { startTranscodeProxy, stopTranscodeProxy, proxyUrl }
