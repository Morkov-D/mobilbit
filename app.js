(() => {
  'use strict';

  const CONFIG = window.APP_CONFIG || {};
  const API_URL = String(CONFIG.API_URL || '').trim();
  const SYNC_INTERVAL_MS =
    Math.max(1, Number(CONFIG.SYNC_INTERVAL_HOURS || 6)) * 60 * 60 * 1000;

  const DB_NAME = 'gtin-label-scanner';
  const DB_VERSION = 1;

  const els = {
    video: document.getElementById('video'),
    startBtn: document.getElementById('startBtn'),
    torchBtn: document.getElementById('torchBtn'),
    syncBtn: document.getElementById('syncBtn'),
    cameraPlaceholder: document.getElementById('cameraPlaceholder'),
    scannerMode: document.getElementById('scannerMode'),
    dbDot: document.getElementById('dbDot'),
    dbText: document.getElementById('dbText'),
    resultCard: document.getElementById('resultCard'),
    resultLabel: document.getElementById('resultLabel'),
    resultDate: document.getElementById('resultDate'),
    resultGtin: document.getElementById('resultGtin'),
    resultStatus: document.getElementById('resultStatus'),
    manualGtin: document.getElementById('manualGtin'),
    manualBtn: document.getElementById('manualBtn'),
    footerInfo: document.getElementById('footerInfo')
  };

  let db = null;
  let gtinMap = new Map();

  let stream = null;
  let cameraTrack = null;
  let detector = null;
  let scanning = false;
  let nativeLoopToken = 0;
  let zxingControls = null;
  let torchOn = false;

  let lastCode = '';
  let lastCodeAt = 0;
  let audioContext = null;

  document.addEventListener('DOMContentLoaded', init);
  els.startBtn.addEventListener('click', toggleCamera);
  els.torchBtn.addEventListener('click', toggleTorch);
  els.syncBtn.addEventListener('click', () => syncData(true));
  els.manualBtn.addEventListener('click', manualLookup);
  els.manualGtin.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') manualLookup();
  });

  window.addEventListener('pagehide', stopCamera);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCamera();
  });

  async function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    try {
      db = await openDb();
      await loadLocalCache();

      if (gtinMap.size > 0) {
        setDbStatus('ok', `Локально: ${gtinMap.size} GTIN`);
        syncData(false);
      } else {
        setDbStatus('warn', 'Локальная база пустая. Загружаю справочник…');
        await syncData(true);
      }
    } catch (err) {
      console.error(err);
      setDbStatus('error', 'Ошибка локальной базы');
      showSystemError(err.message || String(err));
    }
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = () => {
        const upgradeDb = req.result;

        if (!upgradeDb.objectStoreNames.contains('gtins')) {
          upgradeDb.createObjectStore('gtins', { keyPath: 'gtin' });
        }

        if (!upgradeDb.objectStoreNames.contains('meta')) {
          upgradeDb.createObjectStore('meta');
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Не удалось открыть IndexedDB.'));
    });
  }

  async function loadLocalCache() {
    const tx = db.transaction(['gtins', 'meta'], 'readonly');
    const itemsReq = tx.objectStore('gtins').getAll();
    const versionReq = tx.objectStore('meta').get('version');
    const lastSyncReq = tx.objectStore('meta').get('lastSync');

    const [items, version, lastSync] = await Promise.all([
      requestToPromise(itemsReq),
      requestToPromise(versionReq),
      requestToPromise(lastSyncReq)
    ]);

    gtinMap = new Map((items || []).map(item => [String(item.gtin), item]));
    updateFooter(version || '', lastSync || 0);
  }

  async function syncData(force) {
    if (!API_URL || API_URL.includes('PASTE_APPS_SCRIPT')) {
      setDbStatus(
        gtinMap.size ? 'ok' : 'error',
        gtinMap.size
          ? `Локально: ${gtinMap.size} GTIN. API пока не настроен.`
          : 'В config.js не указан URL Apps Script.'
      );
      return;
    }

    const meta = await readMeta();

    if (
      !force &&
      gtinMap.size > 0 &&
      meta.lastSync &&
      Date.now() - Number(meta.lastSync) < SYNC_INTERVAL_MS
    ) {
      return;
    }

    setSyncing(true);

    try {
      const response = await jsonpRequest(API_URL, meta.version || '');

      if (!response || response.ok !== true) {
        throw new Error(response && response.error
          ? response.error
          : 'Сервер вернул некорректный ответ.');
      }

      if (response.changed) {
        const items = Array.isArray(response.items) ? response.items : [];
        await replaceCache(items, response.version || '');
        gtinMap = new Map(items.map(item => [String(item.gtin), item]));
      } else {
        await writeMeta('lastSync', Date.now());
      }

      const refreshed = await readMeta();

      setDbStatus('ok', `Локально: ${gtinMap.size} GTIN`);
      updateFooter(refreshed.version || response.version || '', refreshed.lastSync || Date.now());

    } catch (err) {
      console.error(err);

      if (gtinMap.size > 0) {
        setDbStatus(
          'ok',
          `Офлайн-режим: ${gtinMap.size} GTIN. Обновить сейчас не удалось.`
        );
      } else {
        setDbStatus('error', 'Не удалось загрузить справочник.');
        showSystemError(err.message || String(err));
      }
    } finally {
      setSyncing(false);
    }
  }

  function readMeta() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly');
      const store = tx.objectStore('meta');
      const versionReq = store.get('version');
      const lastSyncReq = store.get('lastSync');

      Promise.all([
        requestToPromise(versionReq),
        requestToPromise(lastSyncReq)
      ]).then(([version, lastSync]) => {
        resolve({ version: version || '', lastSync: lastSync || 0 });
      }).catch(reject);
    });
  }

  function writeMeta(key, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('Ошибка записи meta.'));
      tx.onabort = () => reject(tx.error || new Error('Запись meta отменена.'));
    });
  }

  function replaceCache(items, version) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['gtins', 'meta'], 'readwrite');
      const gtins = tx.objectStore('gtins');
      const meta = tx.objectStore('meta');

      gtins.clear();

      for (const item of items) {
        if (!item || !item.gtin) continue;

        gtins.put({
          gtin: normalizeGtin(item.gtin),
          date: String(item.date || ''),
          status: String(item.status || '')
        });
      }

      meta.put(version, 'version');
      meta.put(Date.now(), 'lastSync');

      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('Ошибка обновления локального справочника.'));
      tx.onabort = () => reject(tx.error || new Error('Обновление локального справочника отменено.'));
    });
  }

  function requestToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Ошибка IndexedDB.'));
    });
  }

  function jsonpRequest(baseUrl, version) {
    return new Promise((resolve, reject) => {
      const callbackName =
        '__gtin_cb_' +
        Date.now() +
        '_' +
        Math.random().toString(36).slice(2, 9);

      let done = false;
      const script = document.createElement('script');

      const cleanup = () => {
        if (script.parentNode) script.parentNode.removeChild(script);
        try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
      };

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error('Таймаут обновления справочника.'));
      }, 15000);

      window[callbackName] = (data) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanup();
        resolve(data);
      };

      try {
        const url = new URL(baseUrl);
        url.searchParams.set('callback', callbackName);
        if (version) url.searchParams.set('version', version);
        url.searchParams.set('_', Date.now().toString());

        script.src = url.toString();
        script.async = true;
        script.onerror = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          cleanup();
          reject(new Error('Сервер Apps Script недоступен.'));
        };

        document.head.appendChild(script);
      } catch (err) {
        clearTimeout(timer);
        cleanup();
        reject(err);
      }
    });
  }

  async function toggleCamera() {
    if (scanning || stream) {
      stopCamera();
      return;
    }

    await startCamera();
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showSystemError('Этот браузер не предоставляет доступ к камере.');
      return;
    }

    try {
      ensureAudioContext();

      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 }
        },
        audio: false
      });

      els.video.srcObject = stream;
      await els.video.play();

      cameraTrack = stream.getVideoTracks()[0] || null;
      scanning = true;
      els.cameraPlaceholder.classList.add('hidden');
      els.startBtn.textContent = 'Остановить';

      configureTorchButton();

      if ('BarcodeDetector' in window) {
        try {
          const supported = await BarcodeDetector.getSupportedFormats();

          if (supported.includes('ean_13')) {
            detector = new BarcodeDetector({ formats: ['ean_13'] });
            els.scannerMode.textContent = 'Режим: быстрый EAN‑13';
            runNativeScanner(++nativeLoopToken);
            return;
          }
        } catch (err) {
          console.warn('BarcodeDetector init failed:', err);
        }
      }

      await startZxingFallback();

    } catch (err) {
      console.error(err);
      stopCamera();

      if (err && err.name === 'NotAllowedError') {
        showSystemError('Нет доступа к камере. Разрешите камеру для этого сайта.');
      } else {
        showSystemError('Не удалось запустить камеру: ' + (err.message || err));
      }
    }
  }

  async function runNativeScanner(token) {
    while (scanning && token === nativeLoopToken && detector) {
      try {
        if (els.video.readyState >= 2) {
          const barcodes = await detector.detect(els.video);
          if (barcodes && barcodes.length) {
            handleCode(barcodes[0].rawValue);
          }
        }
      } catch (_) {
        // Отдельный неудачный кадр не должен останавливать сканер.
      }

      await sleep(70);
    }
  }

  async function startZxingFallback() {
    if (!window.ZXingBrowser) {
      throw new Error('ZXing не загрузился.');
    }

    const Reader =
      ZXingBrowser.BrowserMultiFormatOneDReader ||
      ZXingBrowser.BrowserMultiFormatReader;

    const reader = new Reader();

    els.scannerMode.textContent = 'Режим: совместимый ZXing';

    zxingControls = await reader.decodeFromStream(
      stream,
      els.video,
      (result) => {
        if (result) {
          const text = typeof result.getText === 'function'
            ? result.getText()
            : String(result.text || result);

          handleCode(text);
        }
      }
    );
  }

  function stopCamera() {
    scanning = false;
    nativeLoopToken++;
    detector = null;

    if (zxingControls && typeof zxingControls.stop === 'function') {
      try { zxingControls.stop(); } catch (_) {}
    }
    zxingControls = null;

    if (stream) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch (_) {}
      }
    }

    stream = null;
    cameraTrack = null;
    torchOn = false;

    els.video.srcObject = null;
    els.cameraPlaceholder.classList.remove('hidden');
    els.startBtn.textContent = 'Сканировать';
    els.torchBtn.classList.add('hidden');
    els.torchBtn.classList.remove('active');
    els.scannerMode.textContent = '';
  }

  function configureTorchButton() {
    els.torchBtn.classList.add('hidden');

    if (!cameraTrack || typeof cameraTrack.getCapabilities !== 'function') {
      return;
    }

    try {
      const caps = cameraTrack.getCapabilities();
      if (caps && caps.torch) {
        els.torchBtn.classList.remove('hidden');
      }
    } catch (_) {}
  }

  async function toggleTorch() {
    if (!cameraTrack) return;

    torchOn = !torchOn;

    try {
      await cameraTrack.applyConstraints({
        advanced: [{ torch: torchOn }]
      });

      els.torchBtn.classList.toggle('active', torchOn);
      els.torchBtn.textContent = torchOn ? 'Фонарик ✓' : 'Фонарик';
    } catch (err) {
      torchOn = false;
      els.torchBtn.classList.remove('active');
      els.torchBtn.textContent = 'Фонарик';
    }
  }

  function manualLookup() {
    const gtin = normalizeGtin(els.manualGtin.value);

    if (!gtin) {
      showSystemError('Введите GTIN.');
      return;
    }

    handleCode(gtin, true);
    els.manualGtin.select();
  }

  function handleCode(rawValue, manual = false) {
    const gtin = normalizeGtin(rawValue);
    if (!gtin) return;

    const now = Date.now();

    // Камера постоянно видит один и тот же штрихкод.
    // Не даём одному коду срабатывать десятки раз в секунду.
    if (!manual && gtin === lastCode && now - lastCodeAt < 1800) {
      return;
    }

    lastCode = gtin;
    lastCodeAt = now;

    const item = gtinMap.get(gtin);

    if (item) {
      showResult(item);
      feedback(true);
    } else {
      showNotFound(gtin);
      feedback(false);
    }
  }

  function showResult(item) {
    els.resultCard.className = 'result-card success';
    els.resultLabel.textContent = 'Нанести дату';
    els.resultDate.textContent = item.date || '—';
    els.resultGtin.textContent = 'GTIN ' + item.gtin;
    els.resultStatus.textContent = item.status ? 'Статус: ' + item.status : '';
    flashResult();
  }

  function showNotFound(gtin) {
    els.resultCard.className = 'result-card error';
    els.resultLabel.textContent = 'GTIN не найден';
    els.resultDate.textContent = '—';
    els.resultGtin.textContent = 'GTIN ' + gtin;
    els.resultStatus.textContent = 'Проверьте справочник или обновите данные';
    flashResult();
  }

  function showSystemError(message) {
    els.resultCard.className = 'result-card error';
    els.resultLabel.textContent = 'Ошибка';
    els.resultDate.textContent = '—';
    els.resultGtin.textContent = message;
    els.resultStatus.textContent = '';
    flashResult();
  }

  function flashResult() {
    els.resultCard.classList.remove('flash');
    void els.resultCard.offsetWidth;
    els.resultCard.classList.add('flash');

    setTimeout(() => {
      els.resultCard.classList.remove('flash');
    }, 140);
  }

  function feedback(ok) {
    if (navigator.vibrate) {
      navigator.vibrate(ok ? 55 : [70, 45, 70]);
    }

    beep(ok);
  }

  function ensureAudioContext() {
    if (audioContext) return audioContext;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;

    try {
      audioContext = new Ctx();
    } catch (_) {
      audioContext = null;
    }

    return audioContext;
  }

  function beep(ok) {
    const ctx = ensureAudioContext();
    if (!ctx) return;

    try {
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.value = ok ? 880 : 220;

      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.10);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.11);
    } catch (_) {}
  }

  function normalizeGtin(value) {
    return String(value || '').replace(/[^\d]/g, '');
  }

  function setDbStatus(state, text) {
    els.dbText.textContent = text;
    els.dbDot.className = 'dot';

    if (state === 'ok') els.dbDot.classList.add('ok');
    if (state === 'error') els.dbDot.classList.add('error');
  }

  function setSyncing(value) {
    els.syncBtn.disabled = value;
    els.syncBtn.classList.toggle('syncing', value);
  }

  function updateFooter(version, lastSync) {
    const shortVersion = version ? String(version).slice(0, 8) : '—';

    if (!lastSync) {
      els.footerInfo.textContent = `Версия базы: ${shortVersion}`;
      return;
    }

    const date = new Date(Number(lastSync));

    els.footerInfo.textContent =
      `База: ${gtinMap.size} • версия ${shortVersion} • обновлено ` +
      date.toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
})();
