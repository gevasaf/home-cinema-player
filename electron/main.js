const { app, BrowserWindow, ipcMain, session } = require('electron')
const path = require('path')

const { createStorageHandlers } = require('./ipc/storage')
const { createTmdbHandlers } = require('./ipc/tmdb')
const { createYtdlpHandlers } = require('./ipc/ytdlp')
const { createDebridHandlers } = require('./ipc/debrid')
const { createSubtitlesHandlers } = require('./ipc/subtitles')
const { startTranscodeProxy, stopTranscodeProxy } = require('./ipc/transcodeProxy')

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  await startTranscodeProxy()
  // Allow Shaka Player to fetch YouTube CDN streams from the renderer
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['*://*.googlevideo.com/*'] },
    (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Access-Control-Allow-Origin': ['*'],
          'Access-Control-Allow-Methods': ['GET, HEAD, OPTIONS'],
        },
      })
    }
  )

  createWindow()

  const store = createStorageHandlers(ipcMain, mainWindow)
  createTmdbHandlers(ipcMain, store)
  createYtdlpHandlers(ipcMain, store)
  createDebridHandlers(ipcMain, store)
  createSubtitlesHandlers(ipcMain, store)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopTranscodeProxy()
  if (process.platform !== 'darwin') app.quit()
})
