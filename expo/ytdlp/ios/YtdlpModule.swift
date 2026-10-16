import AVFoundation
import ExpoModulesCore

// YouTube serves video and audio as separate streams; yt-dlp merges them with
// ffmpeg. iOS can do the same copy-only merge (no re-encode) with AVFoundation.
public class YtdlpModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Ytdlp")

    AsyncFunction("mux") { (video: URL, audio: URL, output: URL, durationMs: Double) async throws in
      try await mux(video: video, audio: audio, output: output, durationMs: durationMs)
    }
  }
}

func mux(video: URL, audio: URL, output: URL, durationMs: Double) async throws {
  // the assets must outlive insertTimeRange, or it fails with -12780
  let sources = [(AVURLAsset(url: video), AVMediaType.video), (AVURLAsset(url: audio), .audio)]
  var tracks: [AVAssetTrack] = []
  for (asset, type) in sources {
    guard let track = try await asset.loadTracks(withMediaType: type).first else {
      throw Exception(name: "MuxError", description: "No \(type.rawValue) track in \(asset.url.lastPathComponent)")
    }
    tracks.append(track)
  }
  // YouTube's DASH headers claim twice the real length, so trust its approxDurationMs instead
  let range = CMTimeRange(start: .zero, duration: CMTime(value: CMTimeValue(durationMs), timescale: 1000))

  let composition = AVMutableComposition()
  for track in tracks {
    try composition.addMutableTrack(withMediaType: track.mediaType, preferredTrackID: kCMPersistentTrackID_Invalid)!
      .insertTimeRange(range, of: track, at: .zero)
  }

  guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
    throw Exception(name: "MuxError", description: "Can't export this pair")
  }
  try? FileManager.default.removeItem(at: output)
  export.outputURL = output
  export.outputFileType = .mp4
  await export.export()
  if export.status != .completed {
    throw Exception(name: "MuxError", description: export.error?.localizedDescription ?? "Merge failed")
  }
  _ = sources // keep alive through the export
}
