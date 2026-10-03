import {defineConfig} from 'tsup'

export default defineConfig({
  // the cli, plus the desktop app's main process (`npm run app`)
  entry: {cli: 'src/cli.tsx', 'electron-main': 'src/electron/main.ts', server: 'src/server/hosted.ts'},
  external: ['electron'],
  format: 'esm',
  target: 'node18',
  clean: true,
  banner: {js: '#!/usr/bin/env node'},
})
