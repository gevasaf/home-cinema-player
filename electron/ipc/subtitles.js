const https = require('https')

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      // Follow redirects, resolving relative location headers against the original URL
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const location = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href
        return httpsGet(location, headers).then(resolve).catch(reject)
      }
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve(data))
    }).on('error', reject)
  })
}

function srtToVtt(srt) {
  let vtt = 'WEBVTT\n\n'
  // Replace SRT timestamps (00:00:00,000 --> 00:00:00,000) with VTT (comma → dot)
  vtt += srt
    .replace(/\r\n/g, '\n')
    .replace(/^\d+\n/gm, '')                       // remove cue numbers
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')  // comma → dot
    .trim()
  return vtt
}

function createSubtitlesHandlers(ipcMain, store) {
  ipcMain.handle('subtitles:fetch', async (_event, imdbId, language) => {
    const apiKey = store.get('settings.openSubtitlesApiKey')
    if (!apiKey) throw new Error('OpenSubtitles API key not configured')

    const lang = language || store.get('settings.subtitleLanguage') || 'en'

    // Search for subtitle
    const searchUrl = `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${imdbId.replace('tt', '')}&languages=${lang}&order_by=download_count`
    const searchRaw = await httpsGet(searchUrl, {
      'Api-Key': apiKey,
      'Content-Type': 'application/json',
      'User-Agent': 'cinema-player v1',
    })

    let searchData
    try { searchData = JSON.parse(searchRaw) } catch {
      throw new Error('OpenSubtitles search returned invalid JSON')
    }

    const sub = (searchData.data || [])[0]
    if (!sub) throw new Error(`No subtitles found for ${imdbId} (${lang})`)

    const fileId = sub.attributes?.files?.[0]?.file_id
    if (!fileId) throw new Error('OpenSubtitles: no file_id in result')

    // Request download link
    const dlRaw = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ file_id: fileId })
      const req = https.request(
        {
          hostname: 'api.opensubtitles.com',
          path: '/api/v1/download',
          method: 'POST',
          headers: {
            'Api-Key': apiKey,
            'Content-Type': 'application/json',
            'User-Agent': 'cinema-player v1',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let d = ''
          res.on('data', (c) => { d += c })
          res.on('end', () => resolve(d))
        }
      )
      req.on('error', reject)
      req.write(body)
      req.end()
    })

    let dlData
    try { dlData = JSON.parse(dlRaw) } catch {
      throw new Error('OpenSubtitles download returned invalid JSON')
    }

    const downloadLink = dlData.link
    if (!downloadLink) throw new Error('OpenSubtitles: no download link returned')

    const srtContent = await httpsGet(downloadLink)
    return srtToVtt(srtContent)
  })
}

module.exports = { createSubtitlesHandlers, srtToVtt }
