import {createReadStream} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {Writable} from 'node:stream'

// a minimal zip writer: store-only (mp3/m4a/mp4 are already compressed),
// no zip64 — enough for a playlist's worth of tracks, with no dependencies

const CRC_TABLE = Uint32Array.from({length: 256}, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

async function crc32(file: string): Promise<number> {
  let crc = 0xffffffff
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return {time, day}
}

const write = (out: Writable, data: Buffer) =>
  new Promise<void>((resolve, reject) => {
    out.once('error', reject)
    if (out.write(data)) resolve()
    else out.once('drain', resolve)
  }).finally(() => out.removeAllListeners('error'))

/** Files directly inside `dir` (the playlist folder is flat), in name order. */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, {withFileTypes: true})
  return entries
    .filter(e => e.isFile() && !e.name.startsWith('.') && !/\.(part|ytdl|json)$/i.test(e.name))
    .map(e => e.name)
    .sort()
}

export const ZIP_LIMIT = 0xfffffffe // no zip64

/** Total size the archive would have, or undefined when it can't be a plain zip. */
export async function zipSize(dir: string, names: string[]): Promise<number | undefined> {
  let total = 22
  for (const name of names) {
    const {size} = await fs.stat(path.join(dir, name))
    total += 30 + 46 + 2 * Buffer.byteLength(name) + size
  }
  return total < ZIP_LIMIT && names.length < 0xffff ? total : undefined
}

export async function writeZip(dir: string, names: string[], out: Writable, aborted: () => boolean) {
  const central: Buffer[] = []
  let offset = 0
  const emit = async (data: Buffer) => {
    await write(out, data)
    offset += data.length
  }
  for (const name of names) {
    if (aborted()) return
    const file = path.join(dir, name)
    const stat = await fs.stat(file)
    const crc = await crc32(file)
    const label = Buffer.from(name)
    const {time, day} = dosDateTime(stat.mtime)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // utf-8 names
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(stat.size, 18)
    local.writeUInt32LE(stat.size, 22)
    local.writeUInt16LE(label.length, 26)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(0, 10)
    entry.writeUInt16LE(time, 12)
    entry.writeUInt16LE(day, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(stat.size, 20)
    entry.writeUInt32LE(stat.size, 24)
    entry.writeUInt16LE(label.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, label)

    await emit(Buffer.concat([local, label]))
    for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
      if (aborted()) return
      await emit(chunk)
    }
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(names.length, 8)
  end.writeUInt16LE(names.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  await write(out, Buffer.concat([directory, end]))
  out.end()
}
