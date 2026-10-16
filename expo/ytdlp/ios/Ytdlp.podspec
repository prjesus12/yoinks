Pod::Spec.new do |s|
  s.name           = 'Ytdlp'
  s.version        = '0.1.0'
  s.summary        = 'Merges YouTube video + audio streams with AVFoundation'
  s.author         = ''
  s.homepage       = 'https://github.com/yt-dlp/yt-dlp'
  s.license        = 'Unlicense'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files   = '**/*.swift'
end
