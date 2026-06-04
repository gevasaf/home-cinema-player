const https = require('https')
const AdmZip = require('adm-zip')

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const location = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href
        return httpsGet(location, headers).then(resolve).catch(reject)
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    }).on('error', reject)
  })
}

function srtToVtt(srt) {
  let vtt = 'WEBVTT\n\n'
  vtt += srt
    .replace(/\r\n/g, '\n')
    .replace(/^\d+\n/gm, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .trim()
  return vtt
}

async function fetchFromSubDL(imdbId, lang, apiKey) {
  const langCode = lang.toUpperCase().slice(0, 2)
  const searchUrl = `https://api.subdl.com/api/v1/subtitles?api_key=${apiKey}&imdb_id=${imdbId}&languages=${langCode}&type=movie`
  const raw = await httpsGet(searchUrl)
  let data
  try { data = JSON.parse(raw.toString()) } catch {
    throw new Error(`SubDL returned invalid JSON: ${raw.toString().slice(0, 200)}`)
  }
  if (!data.status) throw new Error(`SubDL error: ${data.message || 'unknown'}`)

  const sub = (data.subtitles || [])[0]
  if (!sub) throw new Error(`No subtitles found for ${imdbId} (${langCode})`)

  const zipUrl = `https://dl.subdl.com${sub.url}`
  const zipBuf = await httpsGet(zipUrl)

  const zip = new AdmZip(zipBuf)
  const srtEntry = zip.getEntries().find(e => e.entryName.endsWith('.srt'))
  if (!srtEntry) throw new Error('SubDL zip contained no .srt file')

  return srtToVtt(srtEntry.getData().toString('utf8'))
}

function createSubtitlesHandlers(ipcMain, store) {
  // Fetch a subtitle from a direct URL (curator override). Converts SRT → VTT if needed.
  ipcMain.handle('subtitles:fetch-url', async (_event, url) => {
    const buf = await httpsGet(url)
    const text = buf.toString('utf8')
    return text.trimStart().startsWith('WEBVTT') ? text : srtToVtt(text)
  })

  ipcMain.handle('subtitles:fetch', async (_event, imdbId, language) => {
    const lang = language || store.get('settings.subtitleLanguage') || 'en'

    const subDLKey = store.get('settings.subDLApiKey')
    if (subDLKey) {
      return fetchFromSubDL(imdbId, lang, subDLKey)
    }

    // Fallback: OpenSubtitles
    const osKey = store.get('settings.openSubtitlesApiKey')
    if (!osKey) throw new Error('No subtitle API key configured (set subDLApiKey or openSubtitlesApiKey in settings)')

    const searchUrl = `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${imdbId.replace('tt', '')}&languages=${lang}&order_by=download_count`
    const searchRaw = await httpsGet(searchUrl, {
      'Api-Key': osKey,
      'Content-Type': 'application/json',
      'User-Agent': 'cinema-player v1',
    })

    let searchData
    try { searchData = JSON.parse(searchRaw.toString()) } catch {
      const status = searchRaw.toString().match(/Error (\d{3})/)?.[1]
      throw new Error(status
        ? `OpenSubtitles API error ${status} — try again later`
        : `OpenSubtitles search returned invalid JSON: ${searchRaw.toString().slice(0, 200)}`)
    }

    const sub = (searchData.data || [])[0]
    if (!sub) throw new Error(`No subtitles found for ${imdbId} (${lang})`)

    const fileId = sub.attributes?.files?.[0]?.file_id
    if (!fileId) throw new Error('OpenSubtitles: no file_id in result')

    const dlRaw = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ file_id: fileId })
      const req = https.request(
        {
          hostname: 'api.opensubtitles.com',
          path: '/api/v1/download',
          method: 'POST',
          headers: {
            'Api-Key': osKey,
            'Content-Type': 'application/json',
            'User-Agent': 'cinema-player v1',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve(Buffer.concat(chunks)))
        }
      )
      req.on('error', reject)
      req.write(body)
      req.end()
    })

    let dlData
    try { dlData = JSON.parse(dlRaw.toString()) } catch {
      const status = dlRaw.toString().match(/Error (\d{3})/)?.[1]
      throw new Error(status
        ? `OpenSubtitles API error ${status} — try again later`
        : `OpenSubtitles download returned invalid JSON: ${dlRaw.toString().slice(0, 200)}`)
    }

    const downloadLink = dlData.link
    if (!downloadLink) throw new Error('OpenSubtitles: no download link returned')

    const srtContent = await httpsGet(downloadLink)
    return srtToVtt(srtContent.toString())
  })
}

module.exports = { createSubtitlesHandlers, srtToVtt }
