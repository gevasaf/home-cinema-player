const https = require('https')

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

function createTmdbHandlers(ipcMain, store) {
  function apiKey() {
    const key = store.get('settings.tmdbApiKey')
    if (!key) throw new Error('TMDB API key not configured in settings')
    return key
  }

  ipcMain.handle('tmdb:search', async (_event, title) => {
    const key = apiKey()
    const encoded = encodeURIComponent(title)
    const data = await httpsGet(
      `https://api.themoviedb.org/3/search/movie?api_key=${key}&query=${encoded}`
    )
    return (data.results || []).map(normaliseTmdb)
  })

  ipcMain.handle('tmdb:fetchById', async (_event, imdbId) => {
    const key = apiKey()
    // Find TMDB ID from IMDB ID via find endpoint
    const findData = await httpsGet(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${key}&external_source=imdb_id`
    )
    const movie = (findData.movie_results || [])[0]
    if (!movie) throw new Error(`No TMDB result for IMDB ID ${imdbId}`)

    const [detail, videos] = await Promise.all([
      httpsGet(`https://api.themoviedb.org/3/movie/${movie.id}?api_key=${key}`),
      httpsGet(`https://api.themoviedb.org/3/movie/${movie.id}/videos?api_key=${key}`),
    ])

    const trailer = (videos.results || []).find(
      (v) => v.site === 'YouTube' && v.type === 'Trailer'
    )

    return {
      tmdbId: String(movie.id),
      imdbId: detail.imdb_id || imdbId,
      title: detail.title,
      overview: detail.overview,
      poster: detail.poster_path
        ? `https://image.tmdb.org/t/p/w500${detail.poster_path}`
        : null,
      trailerYtKey: trailer ? trailer.key : null,
    }
  })
}

function normaliseTmdb(m) {
  return {
    tmdbId: String(m.id),
    title: m.title,
    overview: m.overview,
    poster: m.poster_path
      ? `https://image.tmdb.org/t/p/w500${m.poster_path}`
      : null,
  }
}

module.exports = { createTmdbHandlers }
