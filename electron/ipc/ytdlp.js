const { execFile } = require('child_process')
const path = require('path')
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
        '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]',
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

function createYtdlpHandlers(ipcMain, store) {
  ipcMain.handle('ytdlp:resolve', async (_event, ytIdOrUrl) => {
    const binary = getBinaryPath(store)
    return resolveYouTube(binary, ytIdOrUrl)
  })
}

module.exports = { createYtdlpHandlers, resolveYouTube }
