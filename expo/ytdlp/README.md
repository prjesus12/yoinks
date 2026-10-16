# ytdlp (Expo, en el teléfono)

Un port a TypeScript del extractor de YouTube de [yt-dlp](https://github.com/yt-dlp/yt-dlp),
sin servidor: el teléfono le pide los formatos a YouTube, los descarga y los une.

Qué copia de yt-dlp:

- El cliente InnerTube `visionos` (`_DEFAULT_JSLESS_CLIENTS`): urls directas,
  sin descifrar firmas, sin runtime de JS, sin PO token.
- El `visitorData` de la página del video, sin el cual YouTube pide "confirm you're not a bot".
- Descarga en trozos de 10 MiB con `&range=` (googlevideo corta un GET normal a ~600 KB).
- `-f "bv[vcodec^=avc1]+ba[ext=m4a]"`, y la unión que yt-dlp hace con ffmpeg
  se hace aquí con AVFoundation (copia, sin recodificar).

## Instalar en cualquier proyecto Expo

1. Copia esta carpeta a `modules/ytdlp` de tu proyecto.
2. `npx expo install expo-file-system`
3. Para video: `npx expo run:ios` (o un dev build de EAS). Expo Go no carga
   módulos nativos propios, así que ahí solo funciona `audioOnly`.

## Uso

```tsx
import {download, extract} from './modules/ytdlp'

// mp4 hasta 1080p (H.264 + AAC)
const file = await download('https://youtu.be/dQw4w9WgXcQ', {
  onProgress: (done, total) => total && setPct(done / total),
})
console.log(file.uri)

// solo audio (.m4a) — funciona también en Expo Go
await download(url, {audioOnly: true})

// ver primero título / duración / formatos
const info = await extract(url)
await download(info, {maxHeight: 720})
```

Para mandarlo a Fotos o Compartir: `expo-media-library` / `expo-sharing` con `file.uri`.

## Límites

- Solo YouTube (videos y shorts). Sin playlists, directos ni videos "made for kids"
  (el cliente `visionos` no los ve; yt-dlp los saca con clientes que necesitan JS).
- Máximo 1080p: arriba solo hay VP9/AV1, que no se pueden meter en un mp4 de iOS sin recodificar.
- Cuando YouTube rompa algo: copia los valores nuevos de `INNERTUBE_CLIENTS['visionos']`
  de `yt_dlp/extractor/youtube/_base.py` a `CLIENT` en `src/youtube.ts`.
