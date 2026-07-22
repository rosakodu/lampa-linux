import os
import sys
import time
import glob
import signal
import urllib.parse
import subprocess
import threading
import http.server
import json

class HlsTranscoder:
    SEG_DURATION = 4
    AHEAD_WAIT = 12
    AHEAD_SEEK = 20
    MAX_WAIT_FIRST = 90.0
    MAX_WAIT = 60.0

    def __init__(self):
        home = os.path.expanduser("~")
        self.output_dir = os.path.join(home, ".cache", "lampa_hls")
        self.current_hash = None
        self.current_index = None
        self.stream_url = None
        self.duration = 7200.0
        self.start_segment = 0
        self.process = None
        self.lock = threading.Lock()
        os.makedirs(self.output_dir, exist_ok=True)
        self.ffmpeg_log = None
        self._clear_dir()

    def _plugin_bin(self, name):
        script_dir = os.path.dirname(os.path.abspath(__file__))
        project_dir = os.path.dirname(script_dir)
        return os.path.join(project_dir, "bin", name)

    def _process_alive(self):
        return self.process is not None and self.process.poll() is None

    def get_duration(self, url):
        ffprobe_bin = self._plugin_bin("ffprobe")
        if not os.path.exists(ffprobe_bin):
            print(f"[transcoder] ffprobe not found at {ffprobe_bin}", flush=True)
            return 7200.0
        clean_url = url.replace('&play', '')
        if '&preload' not in clean_url:
            clean_url += '&preload'
        cmd = [
            ffprobe_bin,
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            "-analyzeduration", "1000000",
            "-probesize", "1000000",
            clean_url,
        ]
        try:
            print(f"[transcoder] Probing duration for {url}", flush=True)
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
            duration = float(res.stdout.strip())
            if duration > 0:
                print(f"[transcoder] Duration found: {duration}", flush=True)
                return duration
        except Exception as e:
            print(f"[transcoder] Failed to probe duration: {e}", flush=True)
        return 7200.0

    def prepare(self, url, h_hash, index, duration):
        try:
            with self.lock:
                self.duration = duration or 7200.0
                new_stream = (
                    self.current_hash != h_hash
                    or str(self.current_index) != str(index)
                )
                if new_stream:
                    print(f"[transcoder] HLS session start hash={h_hash[:12]}... index={index}", flush=True)
                    self._kill_process_locked()
                    self._clear_dir()
                    self.current_hash = h_hash
                    self.current_index = str(index)
                    self.stream_url = url
                    self.start_segment = 0
                    self._start_ffmpeg_locked(0)
                elif not self._process_alive():
                    latest = self._get_latest_segment_idx()
                    restart_at = 0 if latest is None else latest
                    print(f"[transcoder] HLS FFmpeg dead, restarting at segment {restart_at}", flush=True)
                    self._start_ffmpeg_locked(restart_at)
        except Exception as e:
            print(f"[transcoder] Error in prepare: {e}", flush=True)

    def generate_master_playlist(self, url, h_hash, duration, index, host="http://127.0.0.1:8000"):
        self.prepare(url, h_hash, index, duration)
        m3u8 = [
            "#EXTM3U",
            "#EXT-X-VERSION:7",
            '#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.64002a,mp4a.40.2"',
            f'{host}/hls/media.m3u8?link={urllib.parse.quote(h_hash)}&index={index}'
        ]
        return "\n".join(m3u8)

    def generate_media_playlist(self, url, h_hash, duration, index, host="http://127.0.0.1:8000"):
        seg_duration = self.SEG_DURATION
        total_segments = max(1, int(duration / seg_duration) + 1)
        m3u8 = [
            "#EXTM3U",
            "#EXT-X-VERSION:7",
            f"#EXT-X-TARGETDURATION:{seg_duration}",
            "#EXT-X-MEDIA-SEQUENCE:0",
            "#EXT-X-PLAYLIST-TYPE:VOD",
        ]
        for i in range(total_segments):
            dur = seg_duration
            if i == total_segments - 1:
                dur = max(0.1, duration - (i * seg_duration))
            m3u8.append(f"#EXTINF:{dur:.3f},")
            m3u8.append(f"{host}/hls/segment_{i}.ts?link={urllib.parse.quote(h_hash)}&index={index}")
        m3u8.append("#EXT-X-ENDLIST")
        return "\n".join(m3u8)

    def _segment_ready(self, segment_idx):
        seg_path = os.path.join(self.output_dir, f"segment_{segment_idx}.ts")
        tmp_path = seg_path + ".tmp"
        if not os.path.exists(seg_path):
            return False
        if os.path.exists(tmp_path):
            return False
        try:
            return os.path.getsize(seg_path) > 100
        except OSError:
            return False

    def serve_segment(self, url, h_hash, segment_idx, index="0"):
        seg_path = os.path.join(self.output_dir, f"segment_{segment_idx}.ts")
        with self.lock:
            if self.current_hash != h_hash or str(self.current_index) != str(index):
                print(f"[transcoder] HLS hash/index change on segment {segment_idx}", flush=True)
                self._kill_process_locked()
                self._clear_dir()
                self.current_hash = h_hash
                self.current_index = str(index)
                self.stream_url = url
                self.start_segment = segment_idx
                self._start_ffmpeg_locked(segment_idx)
            elif not self._segment_ready(segment_idx):
                self._ensure_covers_segment_locked(url, segment_idx)

        max_wait = self.MAX_WAIT_FIRST if segment_idx <= 2 else self.MAX_WAIT
        deadline = time.time() + max_wait
        while time.time() < deadline:
            if self._segment_ready(segment_idx):
                time.sleep(0.05)
                try:
                    with open(seg_path, "rb") as f:
                        data = f.read()
                    if data and len(data) > 188:
                        return data
                except OSError:
                    pass

            with self.lock:
                if (
                    not self._segment_ready(segment_idx)
                    and not self._process_alive()
                    and self.current_hash == h_hash
                ):
                    print(f"[transcoder] HLS FFmpeg exited early, restarting for segment {segment_idx}", flush=True)
                    self._start_ffmpeg_locked(segment_idx)

            time.sleep(0.15)

        print(f"[transcoder] HLS segment {segment_idx} not ready after {max_wait}s", flush=True)
        return None

    def _ensure_covers_segment_locked(self, url, segment_idx):
        self.stream_url = url
        latest = self._get_latest_segment_idx()
        alive = self._process_alive()

        if alive:
            if segment_idx < self.start_segment:
                print(f"[transcoder] HLS seek backward to segment {segment_idx}", flush=True)
                self._start_ffmpeg_locked(segment_idx)
                return
            if latest is not None and segment_idx > latest + self.AHEAD_SEEK:
                print(f"[transcoder] HLS seek forward to segment {segment_idx} (latest={latest})", flush=True)
                self._start_ffmpeg_locked(segment_idx)
                return
            return

        start_at = segment_idx if segment_idx > 0 else 0
        if latest is not None and segment_idx <= latest + 1:
            start_at = segment_idx
        print(f"[transcoder] HLS starting FFmpeg for segment {start_at}", flush=True)
        self._start_ffmpeg_locked(start_at)

    def _get_latest_segment_idx(self):
        files = glob.glob(os.path.join(self.output_dir, "segment_*.ts"))
        if not files:
            return None
        max_idx = -1
        for f in files:
            try:
                base = os.path.basename(f)
                if base.endswith(".tmp"):
                    continue
                idx_str = base.replace("segment_", "").replace(".ts", "")
                max_idx = max(max_idx, int(idx_str))
            except Exception:
                pass
        return max_idx if max_idx >= 0 else None

    def _start_ffmpeg_locked(self, segment_idx):
        self._kill_process_locked()

        for f in glob.glob(os.path.join(self.output_dir, "segment_*.ts*")):
            try:
                base = os.path.basename(f)
                idx_str = base.replace("segment_", "").split(".")[0]
                if int(idx_str) >= segment_idx:
                    os.remove(f)
            except Exception:
                pass
        
        # init.mp4 is not needed for MPEG-TS

        ffmpeg_bin = self._plugin_bin("ffmpeg")
        if not os.path.exists(ffmpeg_bin):
            print(f"[transcoder] ffmpeg not found at {ffmpeg_bin}", flush=True)
            return

        try:
            os.chmod(ffmpeg_bin, 0o755)
        except Exception:
            pass

        start_time = segment_idx * self.SEG_DURATION
        cmd = [ffmpeg_bin, "-hide_banner", "-nostdin", "-y"]
        if start_time > 0:
            cmd += ["-ss", str(start_time)]
        cmd += [
            "-i", self.stream_url or "",
            "-fflags", "+genpts",
            "-async", "1",
            "-map", "0:v:0",
            "-map", "0:a:0?",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "23",
            "-maxrate", "4M",
            "-bufsize", "8M",
            "-pix_fmt", "yuv420p",
            "-g", "48",
            "-keyint_min", "48",
            "-sc_threshold", "0",
            "-c:a", "aac",
            "-ac", "2",
            "-b:a", "128k",
            "-f", "hls",
            "-hls_time", str(self.SEG_DURATION),
            "-hls_list_size", "0",
            "-hls_flags", "independent_segments+temp_file",
            "-start_number", str(segment_idx),
            "-hls_segment_filename", os.path.join(self.output_dir, "segment_%d.ts"),
            os.path.join(self.output_dir, "dummy.m3u8"),
        ]

        ffmpeg_log_path = os.path.join(self.output_dir, "ffmpeg.log")
        try:
            if self.ffmpeg_log:
                try:
                    self.ffmpeg_log.close()
                except Exception:
                    pass
            self.ffmpeg_log = open(ffmpeg_log_path, "a")
            self.ffmpeg_log.write(f"\n=== start segment={segment_idx} ss={start_time} ===\n")
            self.ffmpeg_log.flush()
            stderr_val = self.ffmpeg_log
        except Exception:
            stderr_val = subprocess.DEVNULL

        print(f"[transcoder] Starting FFmpeg at segment {segment_idx} (t={start_time}s)", flush=True)
        self.start_segment = segment_idx
        
        env = os.environ.copy()
        for key in ["LD_LIBRARY_PATH", "LD_PRELOAD", "APPDIR", "APPIMAGE"]:
            env.pop(key, None)

        self.process = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=stderr_val,
            start_new_session=True,
            env=env,
        )

    def _kill_process_locked(self):
        if self.process:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except Exception:
                try:
                    self.process.kill()
                except Exception:
                    pass
            try:
                self.process.wait(timeout=2)
            except Exception:
                try:
                    self.process.kill()
                except Exception:
                    pass
            self.process = None

    def _kill_process(self):
        with self.lock:
            self._kill_process_locked()

    def _clear_dir(self):
        for f in glob.glob(os.path.join(self.output_dir, "*")):
            try:
                os.remove(f)
            except Exception:
                pass


transcoder = HlsTranscoder()
torrserver_port = 8090

class TranscoderHandler(http.server.SimpleHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD')
        self.send_header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range, Private-Token')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Access-Control-Allow-Credentials', 'true')

    def end_headers(self):
        self._send_cors_headers()
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()
        
    def do_HEAD(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)
        
        if parsed_url.path == '/hls/master.m3u8':
            query_params = urllib.parse.parse_qs(parsed_url.query)
            link = query_params.get('link', [''])[0]
            index = query_params.get('index', ['0'])[0]
            if link:
                torr_url = f"http://127.0.0.1:{torrserver_port}/stream?link={link}&index={index}&play"
                duration = transcoder.get_duration(torr_url)
                playlist = transcoder.generate_master_playlist(torr_url, link, duration, index)
                body = playlist.encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/x-mpegURL')
                self.send_header('Cache-Control', 'no-cache, no-store')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

        elif parsed_url.path == '/hls/media.m3u8':
            query_params = urllib.parse.parse_qs(parsed_url.query)
            link = query_params.get('link', [''])[0]
            index = query_params.get('index', ['0'])[0]
            if link:
                torr_url = f"http://127.0.0.1:{torrserver_port}/stream?link={link}&index={index}&play"
                duration = transcoder.get_duration(torr_url)
                playlist = transcoder.generate_media_playlist(torr_url, link, duration, index)
                body = playlist.encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/x-mpegURL')
                self.send_header('Cache-Control', 'no-cache, no-store')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

        elif parsed_url.path == '/hls/init.mp4':
            query_params = urllib.parse.parse_qs(parsed_url.query)
            link = query_params.get('link', [''])[0]
            if link:
                init_path = os.path.join(transcoder.output_dir, "init.mp4")
                deadline = time.time() + 5.0
                while time.time() < deadline:
                    if os.path.exists(init_path) and os.path.getsize(init_path) > 0:
                        break
                    time.sleep(0.15)
                if os.path.exists(init_path):
                    with open(init_path, "rb") as f:
                        init_data = f.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'video/mp4')
                    self.send_header('Cache-Control', 'public, max-age=3600')
                    self.send_header('Content-Length', str(len(init_data)))
                    self.end_headers()
                    self.wfile.write(init_data)
                    return
            self.send_error(404, "Init file not ready")
            return

        elif parsed_url.path.startswith('/hls/segment_') or (parsed_url.path.startswith('/hls/') and parsed_url.path.endswith('.ts')):
            query_params = urllib.parse.parse_qs(parsed_url.query)
            link = query_params.get('link', [''])[0]
            index = query_params.get('index', ['0'])[0]
            if link:
                try:
                    filename = os.path.basename(parsed_url.path)
                    name = filename.replace('segment_', '').split('.')[0]
                    seg_idx = int(name)
                    torr_url = f"http://127.0.0.1:{torrserver_port}/stream?link={link}&index={index}&play"
                    segment_data = transcoder.serve_segment(torr_url, link, seg_idx, index=index)
                    if segment_data:
                        self.send_response(200)
                        self.send_header('Content-Type', 'video/MP2T')
                        self.send_header('Cache-Control', 'public, max-age=3600')
                        self.send_header('Content-Length', str(len(segment_data)))
                        self.end_headers()
                        self.wfile.write(segment_data)
                        return
                except Exception as e:
                    print(f"[transcoder] Error serving segment: {e}", flush=True)
            self.send_error(404, "Segment not ready")
            return

        elif parsed_url.path == '/probe_stream':
            query_params = urllib.parse.parse_qs(parsed_url.query)
            link = query_params.get('link', [''])[0]
            index = query_params.get('index', ['0'])[0]
            if link:
                stream_url = f"http://127.0.0.1:{torrserver_port}/stream?link={link}&index={index}&preload"
                ffprobe_bin = transcoder._plugin_bin("ffprobe")
                response_data = {"transcode": False}
                try:
                    cmd = [
                        ffprobe_bin,
                        "-v", "quiet",
                        "-print_format", "json",
                        "-show_streams",
                        "-show_format",
                        "-analyzeduration", "1000000",
                        "-probesize", "1000000",
                        stream_url
                    ]
                    res = subprocess.run(cmd, capture_output=True, text=True, timeout=5.0)
                    if res.returncode == 0:
                        data = json.loads(res.stdout)
                        streams = data.get("streams", [])
                        format_data = data.get("format", {})
                        format_name = format_data.get("format_name", "").lower()
                        need_transcode = False
                        container_ok = False
                        for s_cont in ["mp4", "matroska", "webm", "ogg"]:
                            if s_cont in format_name:
                                container_ok = True
                                break
                        if not container_ok:
                            need_transcode = True
                        video_ok = False
                        for s in streams:
                            codec_type = s.get("codec_type")
                            codec_name = s.get("codec_name", "").lower()
                            if codec_type == "video":
                                if codec_name in ["h264", "vp8", "vp9", "av1"]:
                                    video_ok = True
                                else:
                                    need_transcode = True
                            elif codec_type == "audio":
                                if codec_name not in ["aac", "mp3", "opus", "vorbis", "flac"]:
                                    need_transcode = True
                        if not video_ok:
                            need_transcode = True
                        response_data = {"transcode": need_transcode}
                    else:
                        response_data = {"transcode": False, "error": f"ffprobe code {res.returncode}"}
                except Exception as e:
                    response_data = {"transcode": False, "error": str(e)}
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(response_data).encode('utf-8'))
                return
            self.send_response(400)
            self.end_headers()
            return

        super().do_GET()

def run_server():
    global torrserver_port
    if len(sys.argv) > 1:
        try:
            torrserver_port = int(sys.argv[1])
        except ValueError:
            pass

    server_address = ('127.0.0.1', 8000)
    httpd = http.server.ThreadingHTTPServer(server_address, TranscoderHandler)
    print(f"[transcoder] HLS Transcoder server running on http://127.0.0.1:8000 (TorrServer port: {torrserver_port})", flush=True)
    
    def handle_sigterm(signum, frame):
        print("[transcoder] Shutting down transcoder server...", flush=True)
        transcoder._kill_process()
        sys.exit(0)
    
    signal.signal(signal.SIGTERM, handle_sigterm)
    signal.signal(signal.SIGINT, handle_sigterm)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        transcoder._kill_process()

if __name__ == '__main__':
    run_server()
