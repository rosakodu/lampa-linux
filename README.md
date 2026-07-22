# lampa-linux

[🇬🇧 English](README.md) | [🇷🇺 Русский](README.ru.md)

A standalone **AppImage** desktop application of **Lampa** for Linux featuring an embedded **TorrServer** and a custom **WebM VP8 + Opus Transcoder** for seamless torrent video playback directly inside the built-in Lampa player.

## 📋 Features

- **Built-in Lampa**: Serves static files of Lampa catalog locally on port 8300.
- **Embedded TorrServer**: Automatically launches built-in TorrServer to handle torrent streams locally on port 8090.
- **On-the-Fly WebM VP8 + Opus Transcoding**: Custom background transcode engine using bundled static FFmpeg to transcode incompatible audio/video formats (like H.265/HEVC, AV1, H.264, AC-3, DTS, AAC) to WebM VP8 + Opus on the fly. This enables smooth playback directly inside Lampa's built-in HTML5 player.
- **Standalone AppImage**: One-file executable. No external dependencies, Node.js, or Python installation required.
- **Clean Installation**: No pre-installed trackers, parsers, or third-party plug-ins. Setup everything your way.

## 📦 Setup & Recommendations

Lampa requires you to add your own online providers, plugins, and torrent parsers. Here are the recommended links to get started:

- **TorrServer URL**: Pre-configured in Lampa settings as `http://127.0.0.1:8090`.
- **Search Parsers**: We recommend configuring Jackett/TorrServer search parsers using [JacRed](https://jacred.ru/) (`https://jacred.ru/`).
- **Popular Plugins**:
  - **TMDB / Online Media**: Find plugins in [nb557 Lampa Plugins](https://github.com/nb557/lampa-plugins) or use `https://plugin.rootu.top/tmdb.js`.
  - **CUB Service**: Visit [CUB.red](http://cub.red/) for synced bookmarks and lists.
  - **Jackett Search Plugin**: Find it via [Bylampa Community](https://github.com/bylampa/bylampa.github.io).

## 📥 Installation & Run

1. Download `Lampa-1.0.0.AppImage` from the [Releases](https://github.com/rosakodu/lampa-linux/releases) page.
2. Make it executable:
   ```bash
   chmod +x Lampa-1.0.0.AppImage
   ```
3. Run:
   ```bash
   ./Lampa-1.0.0.AppImage
   ```

## 🚀 Usage

1. Launch `Lampa-1.0.0.AppImage`.
2. In Lampa Settings, configure your plugins and JacRed parser URL.
3. Find any movie or TV show, select a torrent stream, and hit **Play**.
4. The stream will play directly inside the built-in Lampa video player.

## ⚖️ License & Credits

- [Lampa App Source](https://github.com/lampa-app/lampa) (Lampa Creators)
- [TorrServer](https://github.com/YouROK/TorrServer) (YouROK)
- GPL-2.0 License.
