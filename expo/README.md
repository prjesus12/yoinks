# yoinks-expo

yoinks para apps Expo / React Native.

yt-dlp necesita Python y ffmpeg, y una app móvil no puede incluirlos. Por eso
la app habla con un servidor yoinks hosted y se guarda el archivo terminado
en el teléfono.

## Servidor

```sh
npm run build && PORT=4455 YOINKS_PASSWORD=secreto node dist/server.js
```

(`deploy/yoinks.service` sirve para dejarlo corriendo en un VPS.)

## App

```sh
npx expo install expo-file-system
npm install ../yoinks/expo   # o la ruta / versión publicada
```

```tsx
import {createYoinks} from 'yoinks-expo'

const yoinks = createYoinks({server: 'https://yoinks.example.com', password: 'secreto'})

// en un paso: probe → descarga → espera → guarda en Paths.document
const file = await yoinks.yoink(url, {
  onEvent: e => e.type === 'progress' && setPct(e.total ? e.downloaded / e.total : 0),
})
console.log(file.uri)

// o eligiendo el formato
const info = await yoinks.probe(url) // info.choices: 1080p, MP3, M4A…
const file2 = await yoinks.yoink(info, {choice: info.choices.find(c => c.format === 'mp3')!.index})
```

Las playlists llegan como un `.zip`. Para pasarle el archivo a Fotos o a
Compartir, usa `expo-media-library` o `expo-sharing` con `file.uri`.
