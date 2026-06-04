const { defineConfig } = require('vite')
const react = require('@vitejs/plugin-react')

module.exports = defineConfig({
  plugins: [react.default()],
  base: './',
  build: {
    outDir: 'dist/renderer',
  },
  server: {
    port: 5173,
  },
})
