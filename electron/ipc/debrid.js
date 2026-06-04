const https = require('https')

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : new URLSearchParams(body).toString()
    const parsed = new URL(url)
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
        })
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// Torrentio: fetch torrent results for an IMDB ID
async function fetchTorrentio(imdbId) {
  const url = `https://torrentio.strem.fun/stream/movie/${imdbId}.json`
  const data = await httpsGet(url)
  return (data.streams || [])
    .filter((s) => s.infoHash)
    .sort((a, b) => (b.seeders || 0) - (a.seeders || 0))
}

// Real-Debrid: resolve magnet to direct HTTP URL
async function resolveRealDebrid(apiToken, infoHash) {
  const magnet = `magnet:?xt=urn:btih:${infoHash}`

  // Add magnet
  const added = await httpsPost(
    'https://api.real-debrid.com/rest/1.0/torrents/addMagnet',
    { magnet },
    { Authorization: `Bearer ${apiToken}` }
  )
  const torrentId = added.id
  if (!torrentId) throw new Error('Real-Debrid addMagnet failed')

  // Select all files
  await httpsPost(
    `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
    { files: 'all' },
    { Authorization: `Bearer ${apiToken}` }
  )

  // Poll for links (up to 30s)
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const info = await httpsGet(
      `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
      { Authorization: `Bearer ${apiToken}` }
    )
    if (info.status === 'downloaded' && info.links?.length) {
      const unrestricted = await httpsPost(
        'https://api.real-debrid.com/rest/1.0/unrestrict/link',
        { link: info.links[0] },
        { Authorization: `Bearer ${apiToken}` }
      )
      return unrestricted.download
    }
  }
  throw new Error('Real-Debrid: timed out waiting for download link')
}

// AllDebrid: resolve magnet to direct HTTP URL
async function resolveAllDebrid(apiKey, infoHash) {
  const magnet = `magnet:?xt=urn:btih:${infoHash}`
  const encoded = encodeURIComponent(magnet)

  const upload = await httpsGet(
    `https://api.alldebrid.com/v4/magnet/upload?agent=cinema-player&apikey=${apiKey}&magnets[]=${encoded}`
  )
  const magnetData = upload?.data?.magnets?.[0]
  if (!magnetData?.id) throw new Error('AllDebrid upload failed')

  const magnetId = magnetData.id

  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const status = await httpsGet(
      `https://api.alldebrid.com/v4/magnet/status?agent=cinema-player&apikey=${apiKey}&id=${magnetId}`
    )
    const m = status?.data?.magnets
    if (m?.statusCode === 4 && m?.links?.length) {
      const link = m.links[0].link
      const unlocked = await httpsGet(
        `https://api.alldebrid.com/v4/link/unlock?agent=cinema-player&apikey=${apiKey}&link=${encodeURIComponent(link)}`
      )
      return unlocked?.data?.link
    }
  }
  throw new Error('AllDebrid: timed out waiting for download link')
}

function createDebridHandlers(ipcMain, store) {
  ipcMain.handle('debrid:resolve', async (_event, imdbId) => {
    const service = store.get('settings.debridService') || 'real-debrid'
    const streams = await fetchTorrentio(imdbId)
    if (!streams.length) throw new Error(`No Torrentio streams found for ${imdbId}`)

    const { infoHash } = streams[0]

    if (service === 'alldebrid') {
      const apiKey = store.get('settings.allDebridApiKey')
      if (!apiKey) throw new Error('AllDebrid API key not configured')
      return resolveAllDebrid(apiKey, infoHash)
    }

    const apiToken = store.get('settings.realDebridApiToken')
    if (!apiToken) throw new Error('Real-Debrid API token not configured')
    return resolveRealDebrid(apiToken, infoHash)
  })
}

module.exports = { createDebridHandlers }
