(function () {
  'use strict';

  var CONFIG_PREFIX = 'GDC_SENTINEL:';
  var DEFAULT_TOPIC_PREFIX = 'gdc_wa/default';
  var STABLE_CONN_MS = 30 * 1000;          // 稳定连接满 30 秒
  var HEARTBEAT_TIMEOUT_MS = 180 * 1000;   // 180 秒（3 分钟）失联阈值
  var ALERT_COOLDOWN_MS = 20 * 60 * 1000;  // 20 分钟报警冷却
  var BURN_IN_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟防烧屏微偏移
  var MAX_LOGS = 20;

  var STORAGE_KEYS = {
    CONFIG: 'gdc_sentinel_config_v1',
    SCHEDULE: 'gdc_sentinel_schedule_v1',
    OVERRIDE: 'gdc_sentinel_override_v1',
    LOGS: 'gdc_sentinel_logs_v1'
  };

  var WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  var BURN_IN_OFFSETS = [
    [0, 0],
    [3, -2],
    [-3, 3],
    [2, 4],
    [-4, -2],
    [4, 2],
    [-2, -3]
  ];

  // Runtime state
  var state = {
    clientId: 'gdc_ipad_sentinel_' + randomHex(8),
    config: loadJson(STORAGE_KEYS.CONFIG, {
      wssUrl: '',
      username: '',
      password: '',
      topicPrefix: DEFAULT_TOPIC_PREFIX,
      barkUrl: ''
    }),
    schedule: loadJson(STORAGE_KEYS.SCHEDULE, null),
    override: loadJson(STORAGE_KEYS.OVERRIDE, null),
    logs: loadJson(STORAGE_KEYS.LOGS, []),

    mqttClient: null,
    mqttState: 'unconfigured', // unconfigured | connecting | connected | reconnecting | error
    mqttConnected: false,
    mqttConnectedSinceMs: 0,
    reconnectAttempt: 0,
    reconnectTimer: null,

    lastHeartbeatRecvMs: 0,
    lastHeartbeatPayloadTs: 0,
    heartbeatData: null,

    sentinelActive: false,
    sentinelEnteredAtMs: 0,

    alert: {
      isOfflineAlerted: false,
      cooldownUntilMs: 0
    },

    selectedColleague: '',
    wakeLockSentinel: null,
    wakeLockStatus: '检测中',
    burnInIdx: 0,
    toastTimer: null,
    audioUnlocked: false,
    audioRepeatTimer: null
  };

  function randomHex(len) {
    var out = '';
    var chars = '0123456789abcdef';
    if (window.crypto && window.crypto.getRandomValues) {
      var arr = new Uint8Array(len);
      window.crypto.getRandomValues(arr);
      for (var i = 0; i < len; i++) {
        out += chars[arr[i] % 16];
      }
      return out;
    }
    for (var j = 0; j < len; j++) {
      out += chars[Math.floor(Math.random() * 16)];
    }
    return out;
  }

  function loadJson(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed !== null && parsed !== undefined ? parsed : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJson(key, val) {
    try {
      window.localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      // Ignore storage quota errors in private mode
    }
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function formatDateYmd(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function formatTimeHms(d) {
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function normalizeTopicPrefix(prefix) {
    var clean = String(prefix || '').trim().replace(/^\/+|\/+$/g, '');
    return clean || DEFAULT_TOPIC_PREFIX;
  }

  function normalizeConfig(raw) {
    var obj = raw && typeof raw === 'object' ? raw : {};
    return {
      wssUrl: String(obj.wssUrl || '').trim(),
      username: String(obj.username || '').trim(),
      password: String(obj.password || ''),
      topicPrefix: normalizeTopicPrefix(obj.topicPrefix),
      barkUrl: String(obj.barkUrl || '').trim()
    };
  }

  state.config = normalizeConfig(state.config);

  // UTF-8 safe Base64 encode/decode for GDC_SENTINEL: config string
  function encodeUtf8Base64(str) {
    if (window.TextEncoder) {
      var bytes = new TextEncoder().encode(str);
      var bin = '';
      for (var i = 0; i < bytes.length; i++) {
        bin += String.fromCharCode(bytes[i]);
      }
      return window.btoa(bin);
    }
    return window.btoa(unescape(encodeURIComponent(str)));
  }

  function decodeUtf8Base64(b64) {
    var normalized = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    while (normalized.length % 4 !== 0) {
      normalized += '=';
    }
    var bin = window.atob(normalized);
    if (window.TextDecoder) {
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
      return new TextDecoder('utf-8').decode(bytes);
    }
    return decodeURIComponent(escape(bin));
  }

  function parseConfigCode(codeStr) {
    var trimmed = String(codeStr || '').trim();
    if (!trimmed) {
      throw new Error('请先粘贴配置码');
    }
    if (trimmed.indexOf(CONFIG_PREFIX) !== 0) {
      throw new Error('配置码必须以 GDC_SENTINEL: 开头');
    }
    var b64Part = trimmed.slice(CONFIG_PREFIX.length).trim();
    if (!b64Part) {
      throw new Error('配置码内容为空');
    }
    var jsonStr;
    try {
      jsonStr = decodeUtf8Base64(b64Part);
    } catch (e) {
      throw new Error('Base64 解码失败，请检查配置码是否完整');
    }
    var parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e2) {
      throw new Error('配置码 JSON 格式无效');
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('配置码结构不正确');
    }
    var cfg = normalizeConfig(parsed);
    if (!cfg.wssUrl || !/^wss?:\/\//i.test(cfg.wssUrl)) {
      throw new Error('配置码缺少有效的 wssUrl');
    }
    return cfg;
  }

  function buildConfigCode(cfg) {
    var payload = {
      wssUrl: String(cfg.wssUrl || '').trim(),
      username: String(cfg.username || '').trim(),
      password: String(cfg.password || ''),
      topicPrefix: normalizeTopicPrefix(cfg.topicPrefix),
      barkUrl: String(cfg.barkUrl || '').trim()
    };
    return CONFIG_PREFIX + encodeUtf8Base64(JSON.stringify(payload));
  }

  function addLog(msg, level) {
    var item = {
      time: formatTimeHms(new Date()),
      msg: String(msg),
      level: level || 'info'
    };
    state.logs.unshift(item);
    if (state.logs.length > MAX_LOGS) {
      state.logs = state.logs.slice(0, MAX_LOGS);
    }
    saveJson(STORAGE_KEYS.LOGS, state.logs);
    renderLogs();
  }

  // Evaluate override validity & sentinel_active window strictly per contract
  function isOverrideActiveToday(overrideObj, todayStr) {
    return Boolean(
      overrideObj &&
      overrideObj.active === true &&
      overrideObj.date === todayStr
    );
  }

  function getTodayShift(todayStr) {
    if (
      state.schedule &&
      state.schedule.days &&
      typeof state.schedule.days === 'object' &&
      state.schedule.days[todayStr]
    ) {
      return String(state.schedule.days[todayStr]);
    }
    if (
      state.heartbeatData &&
      state.heartbeatData.today_date === todayStr &&
      state.heartbeatData.today_shift
    ) {
      return String(state.heartbeatData.today_shift);
    }
    return '未设置';
  }

  function computeDutySnapshot(nowDate) {
    var todayStr = formatDateYmd(nowDate);
    var mins = nowDate.getHours() * 60 + nowDate.getMinutes();

    // Auto-expire yesterday's override at 00:00
    if (state.override && state.override.active && state.override.date !== todayStr) {
      state.override = {
        active: false,
        date: '',
        mode: '',
        target_engineer: '',
        updated_at: state.override.updated_at || 0,
        source: state.override.source || 'local_expire'
      };
      saveJson(STORAGE_KEYS.OVERRIDE, state.override);
      addLog('跨过 00:00，昨日额外值班已自动归零', 'info');
    }

    var overrideValid = isOverrideActiveToday(state.override, todayStr);
    var todayShift = getTodayShift(todayStr);

    var inLunchWindow = mins >= 11 * 60 && mins < 13 * 60;       // 11:00 <= now < 13:00
    var inEveningWindow = mins >= 16 * 60 + 30 && mins <= 1439;  // 16:30 <= now <= 23:59

    var condOverrideRemote = overrideValid && state.override.mode === 'remote' && inEveningWindow;
    var condNightShift = todayShift === '晚班' && inEveningWindow;
    var condLunchDuty = todayShift === '早班值班' && inLunchWindow;

    var sentinelActive = Boolean(condOverrideRemote || condNightShift || condLunchDuty);

    return {
      todayStr: todayStr,
      mins: mins,
      todayShift: todayShift,
      overrideValid: overrideValid,
      override: state.override,
      sentinelActive: sentinelActive
    };
  }

  // Gentle audio alert using ./assets/alert.wav (no harsh synth)
  var alertAudioEl = null;

  function getAlertAudioEl() {
    if (!alertAudioEl) {
      alertAudioEl = document.getElementById('alertAudio');
      if (!alertAudioEl && typeof window.Audio === 'function') {
        alertAudioEl = new window.Audio('./assets/alert.wav');
        alertAudioEl.preload = 'auto';
      }
    }
    return alertAudioEl;
  }

  function unlockAlertAudio() {
    if (state.audioUnlocked) return;
    var el = getAlertAudioEl();
    if (!el) return;
    try {
      var prevMuted = el.muted;
      el.muted = true;
      var p = el.play();
      if (p && typeof p.then === 'function') {
        p.then(function () {
          try {
            el.pause();
            el.currentTime = 0;
          } catch (e) {}
          el.muted = prevMuted;
          state.audioUnlocked = true;
        }).catch(function () {
          el.muted = prevMuted;
        });
      } else {
        try {
          el.pause();
          el.currentTime = 0;
        } catch (e2) {}
        el.muted = prevMuted;
        state.audioUnlocked = true;
      }
    } catch (e3) {
      // Ignore iOS autoplay unlock failures until next user gesture
    }
  }

  function playAlert(repeat) {
    var times = Number(repeat);
    if (!isFinite(times) || times < 1) times = 1;
    times = Math.floor(times);

    var el = getAlertAudioEl();
    if (!el) return;

    if (state.audioRepeatTimer) {
      window.clearTimeout(state.audioRepeatTimer);
      state.audioRepeatTimer = null;
    }

    var played = 0;
    function playOnce() {
      played += 1;
      try {
        el.muted = false;
        el.pause();
        el.currentTime = 0;
      } catch (e) {}

      var durationMs = (el.duration && isFinite(el.duration) && el.duration > 0)
        ? Math.round(el.duration * 1000)
        : 600;

      var scheduledNext = false;
      function scheduleNext() {
        if (scheduledNext || played >= times) return;
        scheduledNext = true;
        state.audioRepeatTimer = window.setTimeout(function () {
          state.audioRepeatTimer = null;
          playOnce();
        }, 400);
      }

      if (played < times) {
        el.onended = function () {
          el.onended = null;
          scheduleNext();
        };
      } else {
        el.onended = null;
      }

      try {
        var res = el.play();
        if (res && typeof res.catch === 'function') {
          res.catch(function () {
            el.onended = null;
          });
        }
      } catch (e2) {
        el.onended = null;
        return;
      }

      if (played < times) {
        window.setTimeout(function () {
          if (!scheduledNext) {
            el.onended = null;
            scheduleNext();
          }
        }, durationMs + 150);
      }
    }

    playOnce();
  }

  // Bark push via fetch no-cors per contract
  function sendBarkPush(title, body, sound, level) {
    var barkBase = String(state.config.barkUrl || '').trim();
    if (!barkBase) {
      addLog('未配置 Bark 地址，无法发送推送：' + title, 'warn');
      return Promise.resolve(false);
    }
    var cleanBase = barkBase.replace(/\/+$/, '');
    var url =
      cleanBase +
      '/' + encodeURIComponent(title) +
      '/' + encodeURIComponent(body) +
      '?level=' + encodeURIComponent(level || 'timeSensitive') +
      '&sound=' + encodeURIComponent(sound || 'bell') +
      '&group=' + encodeURIComponent('GDC工单');

    return window.fetch(url, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store'
    }).then(function () {
      return true;
    }).catch(function (err) {
      addLog('Bark 请求异常：' + (err && err.message ? err.message : String(err)), 'error');
      return false;
    });
  }

  // MQTT Topics helper
  function getTopics() {
    var p = normalizeTopicPrefix(state.config.topicPrefix);
    return {
      heartbeat: p + '/heartbeat',
      schedule: p + '/schedule',
      override: p + '/override',
      sentinelAlert: p + '/sentinel_alert'
    };
  }

  function clearReconnectTimer() {
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function disconnectMqtt() {
    clearReconnectTimer();
    state.mqttConnected = false;
    state.mqttConnectedSinceMs = 0;
    state.reconnectAttempt = 0;
    if (state.mqttClient) {
      try {
        state.mqttClient.removeAllListeners();
        state.mqttClient.end(true);
      } catch (e) {
        // ignore close error
      }
      state.mqttClient = null;
    }
  }

  function scheduleExponentialReconnect() {
    if (!state.mqttClient || !state.config.wssUrl) return;
    if (state.reconnectTimer) return;

    var delays = [3000, 6000, 12000, 24000, 30000];
    var idx = Math.min(state.reconnectAttempt, delays.length - 1);
    var delayMs = delays[idx];
    state.reconnectAttempt += 1;
    state.mqttState = 'reconnecting';
    renderTopStatus();

    state.reconnectTimer = window.setTimeout(function () {
      state.reconnectTimer = null;
      if (state.mqttClient && !state.mqttConnected) {
        try {
          state.mqttClient.reconnect();
        } catch (e) {
          scheduleExponentialReconnect();
        }
      }
    }, delayMs);
  }

  function connectMqtt() {
    disconnectMqtt();

    var cfg = state.config;
    if (!cfg.wssUrl) {
      state.mqttState = 'unconfigured';
      renderAll();
      return;
    }

    if (!window.mqtt || typeof window.mqtt.connect !== 'function') {
      state.mqttState = 'error';
      addLog('本地 mqtt.min.js 加载异常', 'error');
      renderAll();
      return;
    }

    state.mqttState = 'connecting';
    renderTopStatus();

    var opts = {
      clientId: state.clientId,
      clean: true,
      connectTimeout: 12000,
      keepalive: 45,
      reconnectPeriod: 0 // Managed via exponential backoff above
    };
    if (cfg.username) opts.username = cfg.username;
    if (cfg.password) opts.password = cfg.password;

    var client;
    try {
      client = window.mqtt.connect(cfg.wssUrl, opts);
    } catch (err) {
      state.mqttState = 'error';
      addLog('MQTT 连接地址无效：' + (err && err.message ? err.message : String(err)), 'error');
      renderAll();
      return;
    }

    state.mqttClient = client;

    client.on('connect', function () {
      clearReconnectTimer();
      state.reconnectAttempt = 0;
      state.mqttConnected = true;
      state.mqttConnectedSinceMs = Date.now();
      state.mqttState = 'connected';
      addLog('已连接 EMQX (' + state.clientId + ')', 'ok');

      var t = getTopics();
      client.subscribe(t.heartbeat, { qos: 0 });
      client.subscribe(t.schedule, { qos: 1 });
      client.subscribe(t.override, { qos: 1 });
      renderAll();
    });

    client.on('message', function (topic, payloadBuf) {
      handleMqttMessage(topic, payloadBuf);
    });

    client.on('close', function () {
      var wasConnected = state.mqttConnected;
      state.mqttConnected = false;
      state.mqttConnectedSinceMs = 0;
      if (wasConnected) {
        addLog('EMQX 连接已断开，启动指数退避重连', 'warn');
      }
      scheduleExponentialReconnect();
      renderAll();
    });

    client.on('offline', function () {
      state.mqttConnected = false;
      state.mqttConnectedSinceMs = 0;
      scheduleExponentialReconnect();
      renderAll();
    });

    client.on('error', function (err) {
      state.mqttState = 'error';
      addLog('MQTT 错误：' + (err && err.message ? err.message : '连接失败'), 'warn');
      scheduleExponentialReconnect();
      renderTopStatus();
    });
  }

  function handleMqttMessage(topic, payloadBuf) {
    var text = '';
    try {
      text = payloadBuf ? payloadBuf.toString() : '';
    } catch (e) {
      return;
    }
    if (!text) return;

    var data;
    try {
      data = JSON.parse(text);
    } catch (e2) {
      return;
    }
    if (!data || typeof data !== 'object') return;

    var t = getTopics();
    if (topic === t.heartbeat) {
      onHeartbeatMessage(data);
    } else if (topic === t.schedule) {
      onScheduleMessage(data);
    } else if (topic === t.override) {
      onOverrideMessage(data);
    }
  }

  function onHeartbeatMessage(data) {
    var prevRecv = state.lastHeartbeatRecvMs;
    state.lastHeartbeatRecvMs = Date.now();
    if (typeof data.ts === 'number' && data.ts > 0) {
      state.lastHeartbeatPayloadTs = Math.floor(data.ts);
    } else {
      state.lastHeartbeatPayloadTs = Math.floor(state.lastHeartbeatRecvMs / 1000);
    }
    state.heartbeatData = data;

    if (prevRecv === 0) {
      addLog('收到首次公司端心跳 (' + (data.today_shift || '未知班次') + ')', 'ok');
    }

    // Immediate recovery notification if offline alert was active
    if (state.alert.isOfflineAlerted) {
      state.alert.isOfflineAlerted = false;
      state.alert.cooldownUntilMs = 0;
      addLog('公司端心跳恢复在线，已重置告警并推送恢复通知', 'ok');
      sendBarkPush('【公司端已恢复在线】', '公司插件心跳已恢复正常，iPad 哨兵继续值守中', 'bell', 'timeSensitive');
      showToast('公司端已恢复在线');
    }

    renderAll();
  }

  function onScheduleMessage(data) {
    if (!data.month || typeof data.days !== 'object' || Array.isArray(data.days)) {
      return;
    }
    var scheduleObj = {
      month: String(data.month),
      updated_at: Number(data.updated_at) || Math.floor(Date.now() / 1000),
      self_name: String(data.self_name || ''),
      days: data.days,
      colleagues: Array.isArray(data.colleagues)
        ? data.colleagues.map(function (c) { return String(c).trim(); }).filter(Boolean)
        : []
    };
    state.schedule = scheduleObj;
    saveJson(STORAGE_KEYS.SCHEDULE, scheduleObj);
    addLog('排班已缓存：' + scheduleObj.month + '（同事 ' + scheduleObj.colleagues.length + ' 人）', 'ok');
    renderAll();
  }

  function onOverrideMessage(data) {
    var incomingTs = Number(data.updated_at) || 0;
    var currentTs = state.override ? (Number(state.override.updated_at) || 0) : 0;
    if (state.override && incomingTs > 0 && currentTs > incomingTs) {
      return;
    }

    var todayStr = formatDateYmd(new Date());
    var active = Boolean(data.active === true && data.date === todayStr);
    var normalized = {
      active: active,
      date: active ? String(data.date) : '',
      mode: active ? String(data.mode || '') : '',
      target_engineer: active ? String(data.target_engineer || '').trim() : '',
      updated_at: incomingTs || Math.floor(Date.now() / 1000),
      source: String(data.source || 'remote')
    };

    var changed = JSON.stringify(state.override) !== JSON.stringify(normalized);
    state.override = normalized;
    saveJson(STORAGE_KEYS.OVERRIDE, normalized);

    if (changed) {
      if (normalized.active) {
        var desc = normalized.mode === 'local' ? '额外白班' : '额外晚班';
        if (normalized.target_engineer) {
          desc += '（替班：' + normalized.target_engineer + '）';
        }
        addLog('同步开启今日' + desc + ' [来源: ' + normalized.source + ']', 'ok');
      } else {
        addLog('今日额外值班已关闭 [来源: ' + normalized.source + ']', 'info');
      }
    }
    renderAll();
  }

  function publishOverride(active, mode, targetEngineer) {
    var nowSec = Math.floor(Date.now() / 1000);
    var todayStr = formatDateYmd(new Date());
    var payload = {
      active: Boolean(active),
      date: active ? todayStr : todayStr,
      mode: active ? String(mode || '') : '',
      target_engineer: active ? String(targetEngineer || '').trim() : '',
      updated_at: nowSec,
      source: 'ipad'
    };

    state.override = {
      active: payload.active,
      date: payload.active ? payload.date : '',
      mode: payload.mode,
      target_engineer: payload.target_engineer,
      updated_at: payload.updated_at,
      source: 'ipad'
    };
    saveJson(STORAGE_KEYS.OVERRIDE, state.override);
    renderAll();

    if (state.mqttClient && state.mqttConnected) {
      var t = getTopics();
      state.mqttClient.publish(t.override, JSON.stringify(payload), { qos: 1, retain: true }, function (err) {
        if (err) {
          addLog('额外值班发布失败：' + err.message, 'error');
          showToast('同步发送失败，请检查网络');
        } else {
          addLog(payload.active ? '已向三端同步开启今日额外值班' : '已向三端同步取消今日额外值班', 'ok');
          showToast(payload.active ? '已开启并同步三端' : '已取消今日额外值班');
        }
      });
    } else {
      addLog('当前 MQTT 未连接，额外值班仅在本地生效，待连接后请重新同步', 'warn');
      showToast('MQTT 未连接，已暂存本地');
    }
  }

  function publishSentinelAlert(nowSec) {
    if (!state.mqttClient || !state.mqttConnected) return;
    var t = getTopics();
    var alertPayload = {
      ts: nowSec,
      source: 'ipad',
      event: 'company_offline',
      last_heartbeat_ts: state.lastHeartbeatPayloadTs || 0
    };
    state.mqttClient.publish(t.sentinelAlert, JSON.stringify(alertPayload), { qos: 1, retain: false });
  }

  // Core 1-second tick: clock + strict 3-condition offline detector
  function evaluateSentinelTick() {
    var now = new Date();
    var nowMs = now.getTime();
    var snap = computeDutySnapshot(now);

    if (snap.sentinelActive && !state.sentinelActive) {
      state.sentinelEnteredAtMs = nowMs;
      addLog('进入值班监控时段，哨兵开始布防', 'info');
    } else if (!snap.sentinelActive && state.sentinelActive) {
      state.sentinelEnteredAtMs = 0;
      if (state.alert.isOfflineAlerted) {
        state.alert.isOfflineAlerted = false;
        state.alert.cooldownUntilMs = 0;
      }
      addLog('值班监控时段结束，切换为非值班静默', 'info');
    }
    state.sentinelActive = snap.sentinelActive;

    // 3 mandatory conditions for offline alert:
    // 1. sentinel_active === true
    // 2. iPad connected to EMQX stably for >= 30s
    // 3. >= 180s since last heartbeat (or >= 180s without any heartbeat since window/connection start)
    var connStable = state.mqttConnected && state.mqttConnectedSinceMs > 0 && (nowMs - state.mqttConnectedSinceMs >= STABLE_CONN_MS);

    var baselineMs = state.lastHeartbeatRecvMs > 0
      ? state.lastHeartbeatRecvMs
      : Math.max(state.sentinelEnteredAtMs || nowMs, state.mqttConnectedSinceMs || nowMs);

    var silentDurationMs = nowMs - baselineMs;
    var isHeartbeatTimedOut = silentDurationMs >= HEARTBEAT_TIMEOUT_MS;

    if (snap.sentinelActive && connStable && isHeartbeatTimedOut) {
      if (nowMs >= state.alert.cooldownUntilMs) {
        state.alert.isOfflineAlerted = true;
        state.alert.cooldownUntilMs = nowMs + ALERT_COOLDOWN_MS;
        var nowSec = Math.floor(nowMs / 1000);

        addLog('公司端超过 3 分钟暂无心跳，已推 Bark、播放提示音并广播 sentinel_alert（冷却 20 分钟）', 'warn');
        playAlert(2);
        sendBarkPush(
          '公司端暂无心跳',
          '公司端暂无心跳，可留意下（值班时段已超 3 分钟未收到心跳）',
          'bell',
          'timeSensitive'
        );
        publishSentinelAlert(nowSec);
        showToast('公司端暂无心跳，已发送提醒');
      }
    }

    renderClockAndCapsules(now, snap, nowMs);
  }

  // DOM bindings
  var dom = {};

  function cacheDom() {
    var ids = [
      'stage', 'mqttBadge', 'mqttBadgeText', 'wakeBadge', 'wakeBadgeText',
      'btnTestBark', 'btnSettings', 'dateLine', 'clockHm', 'clockSec',
      'heartbeatCapsule', 'heartbeatLabel', 'heartbeatSub',
      'shiftCapsule', 'todayShiftText', 'sentinelStateText',
      'extraDutyCapsule', 'extraDutyBadgeText',
      'btnExtraDuty', 'btnExtraDutyText', 'subStatusHint',
      'overrideModal', 'btnCloseOverride', 'btnPickSelf', 'pickSelfHint',
      'colleagueCount', 'colleagueList', 'colleagueEmpty', 'manualEngineerInput',
      'btnCancelOverride', 'btnConfirmOverride',
      'settingsModal', 'btnCloseSettings', 'configCodeInput',
      'btnImportCode', 'btnExportCode', 'settingsForm',
      'inputWssUrl', 'inputUsername', 'inputPassword', 'inputTopicPrefix', 'inputBarkUrl',
      'btnClearConfig', 'metaClientId', 'metaScheduleInfo', 'metaWakeLock',
      'btnClearLogs', 'logList', 'toast'
    ];
    for (var i = 0; i < ids.length; i++) {
      dom[ids[i]] = document.getElementById(ids[i]);
    }
  }

  function showToast(msg) {
    if (!dom.toast) return;
    dom.toast.textContent = msg;
    dom.toast.classList.remove('is-hidden');
    if (state.toastTimer) window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(function () {
      dom.toast.classList.add('is-hidden');
    }, 2800);
  }

  function renderTopStatus() {
    if (!dom.mqttBadge) return;
    dom.mqttBadge.setAttribute('data-state', state.mqttState);
    var map = {
      unconfigured: '未配置连接',
      connecting: '正在连接 EMQX…',
      connected: 'EMQX 已连接',
      reconnecting: '断线重连中…',
      error: '连接异常（重连中）'
    };
    dom.mqttBadgeText.textContent = map[state.mqttState] || '未知状态';

    if (state.wakeLockSentinel) {
      dom.wakeBadge.classList.remove('is-hidden');
      dom.wakeBadgeText.textContent = '常亮已锁定';
    } else {
      dom.wakeBadge.classList.add('is-hidden');
    }

    if (dom.metaClientId) dom.metaClientId.textContent = state.clientId;
    if (dom.metaWakeLock) dom.metaWakeLock.textContent = state.wakeLockStatus;
    if (dom.metaScheduleInfo) {
      if (state.schedule && state.schedule.month) {
        var selfPart = state.schedule.self_name ? (' · ' + state.schedule.self_name) : '';
        dom.metaScheduleInfo.textContent = state.schedule.month + selfPart + '（同事 ' + state.schedule.colleagues.length + ' 人）';
      } else {
        dom.metaScheduleInfo.textContent = '尚未同步';
      }
    }
  }

  function renderClockAndCapsules(now, snap, nowMs) {
    if (!dom.clockHm) return;

    dom.dateLine.textContent =
      now.getFullYear() + '年' + pad2(now.getMonth() + 1) + '月' + pad2(now.getDate()) + '日 · ' +
      WEEKDAY_NAMES[now.getDay()];
    dom.clockHm.textContent = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    dom.clockSec.textContent = pad2(now.getSeconds());

    // Heartbeat capsule
    var elapsedSec = state.lastHeartbeatRecvMs > 0
      ? Math.max(0, Math.floor((nowMs - state.lastHeartbeatRecvMs) / 1000))
      : -1;

    var hbState = 'waiting';
    if (!state.config.wssUrl) {
      hbState = 'waiting';
      dom.heartbeatLabel.textContent = '待配置连接';
      dom.heartbeatSub.textContent = '距上次心跳 -- 秒';
    } else if (elapsedSec < 0) {
      if (state.alert.isOfflineAlerted) {
        hbState = 'offline';
        dom.heartbeatLabel.textContent = '公司端失联';
        dom.heartbeatSub.textContent = '超过 180 秒无心跳';
      } else {
        hbState = 'waiting';
        dom.heartbeatLabel.textContent = state.mqttConnected ? '等待公司端心跳' : '等待链路恢复';
        dom.heartbeatSub.textContent = '距上次心跳 -- 秒';
      }
    } else if (elapsedSec >= 180) {
      hbState = snap.sentinelActive ? 'offline' : 'stale';
      dom.heartbeatLabel.textContent = snap.sentinelActive ? '公司端失联' : '公司端静默/离线';
      dom.heartbeatSub.textContent = '距上次心跳 ' + elapsedSec + ' 秒';
    } else if (elapsedSec >= 95) {
      hbState = 'stale';
      dom.heartbeatLabel.textContent = '心跳延迟关注';
      dom.heartbeatSub.textContent = '距上次心跳 ' + elapsedSec + ' 秒';
    } else {
      hbState = 'online';
      dom.heartbeatLabel.textContent = '公司端在线';
      dom.heartbeatSub.textContent = '距上次心跳 ' + elapsedSec + ' 秒';
    }
    dom.heartbeatCapsule.setAttribute('data-hb-state', hbState);

    // Shift & Sentinel capsule
    dom.todayShiftText.textContent = '今日：' + snap.todayShift;
    if (state.alert.isOfflineAlerted && snap.sentinelActive) {
      dom.shiftCapsule.setAttribute('data-sentinel', 'alerting');
      dom.sentinelStateText.textContent = '失联告警冷却中';
      document.body.setAttribute('data-alert-level', 'alert');
    } else if (snap.sentinelActive) {
      dom.shiftCapsule.setAttribute('data-sentinel', 'armed');
      dom.sentinelStateText.textContent = '哨兵布防中';
      document.body.setAttribute('data-alert-level', 'idle');
    } else {
      dom.shiftCapsule.setAttribute('data-sentinel', 'silent');
      dom.sentinelStateText.textContent = '非值班静默';
      document.body.setAttribute('data-alert-level', 'idle');
    }

    // Extra duty capsule & CTA button
    if (snap.overrideValid) {
      dom.extraDutyCapsule.classList.remove('is-hidden');
      var modeLabel = snap.override.mode === 'local' ? '额外白班' : '额外晚班';
      var whoLabel = snap.override.target_engineer
        ? ('替班：' + snap.override.target_engineer)
        : '本人值班';
      dom.extraDutyBadgeText.textContent = modeLabel + ' · ' + whoLabel;

      dom.btnExtraDuty.setAttribute('data-active', 'true');
      dom.btnExtraDutyText.textContent = '取消今日额外值班';
    } else {
      dom.extraDutyCapsule.classList.add('is-hidden');
      dom.btnExtraDuty.setAttribute('data-active', 'false');
      dom.btnExtraDutyText.textContent = '今日额外值班';
    }

    // Bottom subtle hint
    if (!state.config.wssUrl) {
      dom.subStatusHint.textContent = '请点击右上角「连接设置」粘贴 GDC_SENTINEL 配置码';
    } else if (state.alert.isOfflineAlerted && state.alert.cooldownUntilMs > nowMs) {
      var remainMin = Math.ceil((state.alert.cooldownUntilMs - nowMs) / 60000);
      dom.subStatusHint.textContent = '已发送 Bark 失联告警并通知家机 · 冷却剩余约 ' + remainMin + ' 分钟';
    } else if (state.mqttConnected && (nowMs - state.mqttConnectedSinceMs < STABLE_CONN_MS)) {
      var warmSec = Math.ceil((STABLE_CONN_MS - (nowMs - state.mqttConnectedSinceMs)) / 1000);
      dom.subStatusHint.textContent = '链路稳定校验中（' + warmSec + ' 秒后正式启用防误报监测）';
    } else {
      dom.subStatusHint.textContent = '';
    }
  }

  function renderLogs() {
    if (!dom.logList) return;
    dom.logList.innerHTML = '';
    if (!state.logs.length) {
      var empty = document.createElement('li');
      empty.className = 'log-item';
      empty.innerHTML = '<span class="log-msg">暂无状态日志</span>';
      dom.logList.appendChild(empty);
      return;
    }
    for (var i = 0; i < state.logs.length; i++) {
      var entry = state.logs[i];
      var li = document.createElement('li');
      li.className = 'log-item';
      li.setAttribute('data-level', entry.level || 'info');

      var tSpan = document.createElement('span');
      tSpan.className = 'log-time';
      tSpan.textContent = entry.time;

      var mSpan = document.createElement('span');
      mSpan.className = 'log-msg';
      mSpan.textContent = entry.msg;

      li.appendChild(tSpan);
      li.appendChild(mSpan);
      dom.logList.appendChild(li);
    }
  }

  function renderAll() {
    renderTopStatus();
    renderLogs();
    var now = new Date();
    renderClockAndCapsules(now, computeDutySnapshot(now), now.getTime());
  }

  // Override Picker Modal logic
  function openOverrideModal() {
    state.selectedColleague = '';
    dom.manualEngineerInput.value = '';

    var selfName = (state.schedule && state.schedule.self_name) ? state.schedule.self_name : '';
    dom.pickSelfHint.textContent = selfName ? ('本人：' + selfName) : '不指定替班同事';
    dom.btnPickSelf.classList.add('is-selected');

    var rawList = (state.schedule && Array.isArray(state.schedule.colleagues))
      ? state.schedule.colleagues
      : [];
    var colleagues = [];
    for (var i = 0; i < rawList.length; i++) {
      var name = String(rawList[i] || '').trim();
      if (name && name !== selfName && colleagues.indexOf(name) === -1) {
        colleagues.push(name);
      }
    }

    dom.colleagueCount.textContent = colleagues.length + ' 人';
    dom.colleagueList.innerHTML = '';

    if (colleagues.length === 0) {
      dom.colleagueEmpty.classList.remove('is-hidden');
    } else {
      dom.colleagueEmpty.classList.add('is-hidden');
      for (var j = 0; j < colleagues.length; j++) {
        (function (cName) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'pick-chip';
          btn.textContent = cName;
          btn.addEventListener('click', function () {
            state.selectedColleague = cName;
            dom.manualEngineerInput.value = '';
            dom.btnPickSelf.classList.remove('is-selected');
            var chips = dom.colleagueList.querySelectorAll('.pick-chip');
            for (var k = 0; k < chips.length; k++) {
              chips[k].classList.remove('is-selected');
            }
            btn.classList.add('is-selected');
          });
          dom.colleagueList.appendChild(btn);
        })(colleagues[j]);
      }
    }

    dom.overrideModal.classList.remove('is-hidden');
  }

  function closeOverrideModal() {
    dom.overrideModal.classList.add('is-hidden');
  }

  // Settings Modal logic
  function openSettingsModal() {
    dom.inputWssUrl.value = state.config.wssUrl || '';
    dom.inputUsername.value = state.config.username || '';
    dom.inputPassword.value = state.config.password || '';
    dom.inputTopicPrefix.value = state.config.topicPrefix || DEFAULT_TOPIC_PREFIX;
    dom.inputBarkUrl.value = state.config.barkUrl || '';
    renderTopStatus();
    renderLogs();
    dom.settingsModal.classList.remove('is-hidden');
  }

  function closeSettingsModal() {
    dom.settingsModal.classList.add('is-hidden');
  }

  function applyNewConfig(cfg, sourceLabel) {
    state.config = normalizeConfig(cfg);
    saveJson(STORAGE_KEYS.CONFIG, state.config);
    addLog('配置已保存（' + sourceLabel + '），重新建立 MQTT 连接', 'ok');
    connectMqtt();
    renderAll();
  }

  function copyTextCompat(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(function () {
        return true;
      }).catch(function () {
        return fallbackExecCopy(text);
      });
    }
    return Promise.resolve(fallbackExecCopy(text));
  }

  function fallbackExecCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  // Screen Wake Lock API (graceful fallback for older iPadOS)
  function requestWakeLock() {
    if (!('wakeLock' in navigator) || !navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') {
      state.wakeLockStatus = '当前系统不支持（请在设置中设永不锁定）';
      renderTopStatus();
      return;
    }
    try {
      navigator.wakeLock.request('screen').then(function (sentinel) {
        state.wakeLockSentinel = sentinel;
        state.wakeLockStatus = '已锁定屏幕常亮';
        renderTopStatus();
        sentinel.addEventListener('release', function () {
          state.wakeLockSentinel = null;
          state.wakeLockStatus = '等待重新锁定（点击屏幕唤醒）';
          renderTopStatus();
        });
      }).catch(function () {
        state.wakeLockSentinel = null;
        state.wakeLockStatus = '点击屏幕任意位置激活常亮锁';
        renderTopStatus();
      });
    } catch (e) {
      state.wakeLockStatus = '当前浏览器不支持常亮锁';
      renderTopStatus();
    }
  }

  // Subtle 5-minute pixel shift for burn-in protection (2~4px)
  function stepBurnInShift() {
    state.burnInIdx = (state.burnInIdx + 1) % BURN_IN_OFFSETS.length;
    var pair = BURN_IN_OFFSETS[state.burnInIdx];
    if (dom.stage) {
      dom.stage.style.setProperty('--shift-x', pair[0] + 'px');
      dom.stage.style.setProperty('--shift-y', pair[1] + 'px');
    }
  }

  function bindEvents() {
    // Extra duty CTA
    dom.btnExtraDuty.addEventListener('click', function () {
      var now = new Date();
      var snap = computeDutySnapshot(now);
      if (snap.overrideValid) {
        publishOverride(false, '', '');
        return;
      }
      if (snap.mins < 16 * 60 + 30) {
        // Before 16:30 -> switch directly to today's daytime extra duty (mode="local")
        publishOverride(true, 'local', '');
      } else {
        // 16:30 and later -> open glass drawer to pick self or colleague (mode="remote")
        openOverrideModal();
      }
    });

    dom.btnPickSelf.addEventListener('click', function () {
      state.selectedColleague = '';
      dom.manualEngineerInput.value = '';
      dom.btnPickSelf.classList.add('is-selected');
      var chips = dom.colleagueList.querySelectorAll('.pick-chip');
      for (var i = 0; i < chips.length; i++) {
        chips[i].classList.remove('is-selected');
      }
    });

    dom.manualEngineerInput.addEventListener('input', function () {
      var val = dom.manualEngineerInput.value.trim();
      if (val) {
        dom.btnPickSelf.classList.remove('is-selected');
        var chips = dom.colleagueList.querySelectorAll('.pick-chip');
        for (var i = 0; i < chips.length; i++) {
          chips[i].classList.remove('is-selected');
        }
      }
    });

    dom.btnConfirmOverride.addEventListener('click', function () {
      var manual = dom.manualEngineerInput.value.trim();
      var chosen = manual || state.selectedColleague || '';
      closeOverrideModal();
      publishOverride(true, 'remote', chosen);
    });

    dom.btnCloseOverride.addEventListener('click', closeOverrideModal);
    dom.btnCancelOverride.addEventListener('click', closeOverrideModal);
    dom.overrideModal.addEventListener('click', function (e) {
      if (e.target === dom.overrideModal) closeOverrideModal();
    });

    // Top bar actions
    dom.btnTestBark.addEventListener('click', function () {
      unlockAlertAudio();
      playAlert(1);
      if (!state.config.barkUrl) {
        showToast('已试播提示音；请先在「连接设置」配置 Bark 地址');
        openSettingsModal();
        return;
      }
      addLog('手动触发 Bark 测试推送与提示音', 'info');
      showToast('已发送 Bark 测试请求并试播提示音');
      sendBarkPush('iPad 哨兵测试', 'Bark 推送与提示音均正常，iPad 常亮哨兵已就绪', 'bell', 'timeSensitive');
    });

    dom.btnSettings.addEventListener('click', openSettingsModal);
    dom.btnCloseSettings.addEventListener('click', closeSettingsModal);
    dom.settingsModal.addEventListener('click', function (e) {
      if (e.target === dom.settingsModal) closeSettingsModal();
    });

    // Import/Export config code
    dom.btnImportCode.addEventListener('click', function () {
      try {
        var parsed = parseConfigCode(dom.configCodeInput.value);
        dom.configCodeInput.value = '';
        applyNewConfig(parsed, '配置码导入');
        openSettingsModal();
        closeSettingsModal();
        showToast('配置码导入成功，正在连接 EMQX');
      } catch (err) {
        showToast(err && err.message ? err.message : '配置码解析失败');
      }
    });

    dom.btnExportCode.addEventListener('click', function () {
      var draft = normalizeConfig({
        wssUrl: dom.inputWssUrl.value,
        username: dom.inputUsername.value,
        password: dom.inputPassword.value,
        topicPrefix: dom.inputTopicPrefix.value,
        barkUrl: dom.inputBarkUrl.value
      });
      if (!draft.wssUrl) {
        showToast('请先填写 WSS 地址再生成配置码');
        return;
      }
      var code = buildConfigCode(draft);
      dom.configCodeInput.value = code;
      copyTextCompat(code).then(function (copied) {
        showToast(copied ? '配置码已生成并复制到剪贴板' : '配置码已生成在上方文本框，请长按复制');
      });
    });

    dom.settingsForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var draft = normalizeConfig({
        wssUrl: dom.inputWssUrl.value,
        username: dom.inputUsername.value,
        password: dom.inputPassword.value,
        topicPrefix: dom.inputTopicPrefix.value,
        barkUrl: dom.inputBarkUrl.value
      });
      if (!draft.wssUrl || !/^wss?:\/\//i.test(draft.wssUrl)) {
        showToast('请输入以 wss:// 或 ws:// 开头的有效地址');
        return;
      }
      applyNewConfig(draft, '手动保存');
      closeSettingsModal();
      showToast('设置已保存，正在连接');
    });

    dom.btnClearConfig.addEventListener('click', function () {
      disconnectMqtt();
      state.config = normalizeConfig({ topicPrefix: DEFAULT_TOPIC_PREFIX });
      saveJson(STORAGE_KEYS.CONFIG, state.config);
      state.mqttState = 'unconfigured';
      dom.configCodeInput.value = '';
      openSettingsModal();
      renderAll();
      addLog('连接配置已清空', 'warn');
      showToast('配置已清空');
    });

    dom.btnClearLogs.addEventListener('click', function () {
      state.logs = [];
      saveJson(STORAGE_KEYS.LOGS, state.logs);
      renderLogs();
    });

    // Wake Lock re-acquire on visibility / first user gesture
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && !state.wakeLockSentinel) {
        requestWakeLock();
      }
    });

    document.addEventListener('touchstart', function () {
      unlockAlertAudio();
      if (!state.wakeLockSentinel) requestWakeLock();
    }, { passive: true });

    document.addEventListener('click', function () {
      unlockAlertAudio();
      if (!state.wakeLockSentinel) requestWakeLock();
    });
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(function () {
          // Ignore SW error on file:// protocol preview
        });
      });
    }
  }

  function init() {
    cacheDom();
    bindEvents();
    registerServiceWorker();
    requestWakeLock();

    var initSnap = computeDutySnapshot(new Date());
    if (initSnap.sentinelActive) {
      state.sentinelActive = true;
      state.sentinelEnteredAtMs = Date.now();
    }

    renderAll();
    if (state.config.wssUrl) {
      connectMqtt();
    }

    window.setInterval(evaluateSentinelTick, 1000);
    window.setInterval(stepBurnInShift, BURN_IN_INTERVAL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
