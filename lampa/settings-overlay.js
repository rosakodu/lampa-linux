(function () {
  'use strict';

  // ── Pre-clean localStorage immediately ────────────────────────────────────
  try {
    var curNwPath = window.localStorage.getItem('player_nw_path') || '';
    if (!curNwPath || curNwPath.indexOf('C:') !== -1 || curNwPath.indexOf('vlc.exe') !== -1) {
      window.localStorage.setItem('player_nw_path', '/usr/bin/vlc');
      window.localStorage.setItem('player_path', '/usr/bin/vlc');
    }
  } catch (e) {}

  // ── Tiny JS logger → HTTP backend ─────────────────────────────────────────
  var _log = function (msg) {
    try { fetch('http://127.0.0.1:8300/log_js?msg=' + encodeURIComponent(msg)); } catch (e) {}
  };

  // ── Save current Lampa page URL every 3 s ─────────────────────────────────
  setInterval(function () {
    try {
      var u = window.location.href;
      if (u && u.indexOf('127.0.0.1:8300') !== -1) {
        fetch('http://127.0.0.1:8300/save_url?url=' + encodeURIComponent(u)).catch(function(){});
      }
    } catch (e) {}
  }, 3000);

  // ── Persistent localStorage defaults ──────────────────────────────────────
  if (window.localStorage.getItem('lampaelectron_transcode_reset') !== 'v6') {
    window.localStorage.setItem('player',         'video');
    window.localStorage.setItem('player_torrent', 'video');
    window.localStorage.setItem('player_iptv',    'video');
    // TorrServer
    window.localStorage.setItem('torrserver_url',      'http://127.0.0.1:8090');
    window.localStorage.setItem('torrserver_url_two',  'http://127.0.0.1:8090');
    window.localStorage.setItem('torrserver_use_link', 'one');
    window.localStorage.setItem('torrserver_gts',      'false');
    
    // Default Parser setup
    window.localStorage.setItem('jackett_url', 'https://jacred.ru');
    window.localStorage.setItem('parser_torrent_type', 'jackett');

    // Default Player NW Path for Linux
    window.localStorage.setItem('player_nw_path', '/usr/bin/vlc');
    window.localStorage.setItem('player_path', '/usr/bin/vlc');

    window.localStorage.setItem('lampaelectron_transcode_reset', 'v6');
    _log('[lampa-electron] localStorage defaults applied v6');
  }

  // Sanity check: If parser URL is mistakenly set to TorrServer (http://127.0.0.1:8090), fix it to JacRed
  var curJackett = window.localStorage.getItem('jackett_url') || '';
  if (curJackett.indexOf('8090') !== -1) {
    window.localStorage.setItem('jackett_url', 'https://jacred.ru');
    window.localStorage.setItem('parser_torrent_type', 'jackett');
  }

  // Always force built-in player
  window.localStorage.setItem('player',         'video');
  window.localStorage.setItem('player_torrent', 'video');
  window.localStorage.setItem('torrserver_gts', 'false');

  // ── Poll and update Lampa.Storage RAM cache as soon as Lampa is ready ─────
  function fixStorage() {
    if (window.Lampa && window.Lampa.Storage && window.Lampa.Storage.set) {
      try {
        var nwPath = window.Lampa.Storage.get('player_nw_path');
        if (!nwPath || nwPath.indexOf('C:') !== -1 || nwPath.indexOf('vlc.exe') !== -1) {
          window.Lampa.Storage.set('player_nw_path', '/usr/bin/vlc');
          window.Lampa.Storage.set('player_path', '/usr/bin/vlc');
        }
      } catch (e) {}
    } else {
      setTimeout(fixStorage, 50);
    }
  }
  fixStorage();

  // ── Hook Lampa.Player.play ────────────────────────────────────────────────
  function hookPlayer() {
    if (!(window.Lampa && window.Lampa.Player && window.Lampa.Storage)) {
      setTimeout(hookPlayer, 300);
      return;
    }

    _log('[lampa-electron] Hooking Lampa.Player.play for built-in WebM Transcoder');

    var _origPlay = window.Lampa.Player.play.bind(window.Lampa.Player);

    window.Lampa.Player.play = function (data) {
      if (!data || !data.url) {
        return _origPlay(data);
      }

      var streamUrl = data.url || '';

      // Only intercept TorrServer stream URLs
      var isTorr = streamUrl.indexOf('127.0.0.1:8090') !== -1 ||
                   streamUrl.indexOf('localhost:8090')  !== -1;

      if (!isTorr) {
        // Non-torrent URL — pass through unchanged
        return _origPlay(data);
      }

      // Detect timeline position to resume from correct second
      var startTime = 0;
      if (data.timeline && typeof data.timeline.time !== 'undefined') {
        startTime = Math.floor(data.timeline.time);
      }

      // Redirect player to local VP8/Opus WebM live transcode stream
      var transcodedUrl = 'http://127.0.0.1:8300/stream.webm?url=' +
                          encodeURIComponent(streamUrl) +
                          '&start=' + startTime;

      _log('[lampa-electron] Intercepted stream → transcoder: ' + transcodedUrl);

      data.url = transcodedUrl;

      // Built-in HTML5 video player will open the WebM stream
      return _origPlay(data);
    };

    _log('[lampa-electron] Lampa.Player.play hooked — Transcoder mode active');
  }

  hookPlayer();

})();
