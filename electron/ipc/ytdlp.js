const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { app } = require('electron')

function getBinaryPath(store) {
  const custom = store.get('settings.ytdlpBinaryPath')
  if (custom) return custom
  // Default: bundled binary next to the app resources
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'yt-dlp')
    : path.join(__dirname, '../../assets/yt-dlp')
  return process.platform === 'win32' ? `${base}.exe` : base
}

function resolveYouTube(binaryPath, ytIdOrUrl) {
  const url = ytIdOrUrl.startsWith('http')
    ? ytIdOrUrl
    : `https://youtube.com/watch?v=${ytIdOrUrl}`

  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      [
        '--js-runtimes', 'node',
        '--format', 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
        '--get-url',
        url,
      ],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message))
        // yt-dlp may return two URLs (video + audio); take the first (best single stream)
        const urls = stdout.trim().split('\n').filter(Boolean)
        if (!urls.length) return reject(new Error('yt-dlp returned no URL'))
        resolve(urls[0])
      }
    )
  })
}

function resolveYouTubeSubtitles(binaryPath, ytIdOrUrl) {
  const url = ytIdOrUrl.startsWith('http')
    ? ytIdOrUrl
    : `https://youtube.com/watch?v=${ytIdOrUrl}`

  const tmpBase = path.join(os.tmpdir(), `cinema-sub-${Date.now()}`)

  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      [
        '--js-runtimes', 'node',
        '--write-sub', '--write-auto-sub',
        '--sub-lang', 'en',
        '--sub-format', 'vtt',
        '--skip-download',
        '--no-playlist',
        '-o', tmpBase,
        url,
      ],
      { timeout: 30000 },
      (err) => {
        // yt-dlp writes <tmpBase>.en.vtt or <tmpBase>.en-*.vtt
        const candidates = fs.readdirSync(os.tmpdir())
          .filter(f => f.startsWith(path.basename(tmpBase)) && f.endsWith('.vtt'))
          .map(f => path.join(os.tmpdir(), f))

        if (!candidates.length) {
          return reject(new Error(err ? err.message : 'yt-dlp wrote no subtitle file'))
        }

        try {
          const raw = fs.readFileSync(candidates[0], 'utf8')
          candidates.forEach(f => { try { fs.unlinkSync(f) } catch {} })
          // Strip YouTube positioning/alignment metadata from cue timings so
          // subtitles render centred rather than left-aligned.
          const vtt = raw.replace(
            /([\d:.]+ --> [\d:.]+)[ \t][^\n]*/g,
            '$1'
          )
          resolve(vtt)
        } catch (readErr) {
          reject(readErr)
        }
      }
    )
  })
}

function createYtdlpHandlers(ipcMain, store) {
  ipcMain.handle('ytdlp:resolve', async (_event, ytIdOrUrl) => {
    const binary = getBinaryPath(store)
    return resolveYouTube(binary, ytIdOrUrl)
  })

  ipcMain.handle('ytdlp:resolve-subtitles', async (_event, ytIdOrUrl) => {
    const binary = getBinaryPath(store)
    return resolveYouTubeSubtitles(binary, ytIdOrUrl)
  })
}

module.exports = { createYtdlpHandlers, resolveYouTube, resolveYouTubeSubtitles }
