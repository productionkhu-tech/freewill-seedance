/**
 * Seedance R2 hourly cleanup — Apps Script.
 *
 * Time-trigger this script (매시 1회) to delete R2 objects older than 1 hour.
 * AWS S3 V4 signing is implemented inline so no SDK / library install needed.
 *
 * SETUP (one-time):
 *   1. Apps Script Editor → 좌측 톱니바퀴 ⚙ → "Project Settings"
 *   2. 맨 아래 "Script Properties" → "Add script property" 4개 추가:
 *        R2_ENDPOINT          = https://545d611ede4df5505cb90242ce97be78.r2.cloudflarestorage.com
 *        R2_ACCESS_KEY_ID     = (R2 Access Key ID)
 *        R2_SECRET_ACCESS_KEY = (R2 Secret Access Key)
 *        R2_BUCKET            = seedance2-260514
 *   3. 좌측 시계 아이콘 ⏰ → "Add Trigger"
 *        Function: cleanupOldR2
 *        Event source: Time-driven
 *        Type: Hour timer
 *        Hour: Every hour
 *   4. (선택) cleanupOldR2 함수 한 번 직접 실행해서 OAuth 권한 부여 (UrlFetch external)
 */

// ─── Config ───────────────────────────────────────────────
var CUTOFF_HOURS = 1;   // delete objects older than this
var REGION = 'auto';    // R2 always uses 'auto'
var SERVICE = 's3';

// ─── Trigger management ───────────────────────────────────
// 한 번만 실행하면 매시간 자동 트리거 영구 등록됨. UI 안 거쳐도 됨.
function installHourlyTrigger() {
  // 같은 함수의 기존 트리거 다 제거 (중복 등록 방지)
  var existing = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'cleanupOldR2') {
      ScriptApp.deleteTrigger(existing[i]);
      removed++;
    }
  }
  // 새 시간 기반 트리거 — 매 1시간
  ScriptApp.newTrigger('cleanupOldR2').timeBased().everyHours(1).create();
  Logger.log('✓ Hourly trigger installed for cleanupOldR2 (제거: ' + removed + ', 등록: 1)');
}

// 현재 등록된 트리거 전부 조회
function listTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) { Logger.log('등록된 트리거 없음'); return; }
  for (var i = 0; i < triggers.length; i++) {
    var t = triggers[i];
    Logger.log((i+1) + '. function=' + t.getHandlerFunction() +
               '  source=' + t.getEventType() +
               '  uid=' + t.getUniqueId());
  }
}

// 트리거 전부 제거 (cleanup 멈추고 싶을 때)
function uninstallAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) ScriptApp.deleteTrigger(triggers[i]);
  Logger.log('제거된 트리거: ' + triggers.length);
}

// ─── Public entry ─────────────────────────────────────────
function cleanupOldR2() {
  var env = getEnv_();
  var cutoff = Date.now() - CUTOFF_HOURS * 3600 * 1000;
  var cursor = null;
  var total = 0, totalBytes = 0;
  var eligible = 0, eligibleBytes = 0;
  var deleted = 0, failed = 0;
  var deletedKeys = [];

  do {
    var page = listR2_(env, cursor);
    for (var i = 0; i < page.items.length; i++) {
      var o = page.items[i];
      total++; totalBytes += o.size;
      if (o.lastModified.getTime() < cutoff) {
        eligible++; eligibleBytes += o.size;
        try {
          deleteR2_(env, o.key);
          deleted++;
          deletedKeys.push(o.key);
        } catch (e) {
          failed++;
          Logger.log('  ✗ delete fail: ' + o.key + ' — ' + e.message);
        }
      }
    }
    cursor = page.nextCursor;
  } while (cursor);

  var totalMB = (totalBytes/1024/1024).toFixed(2);
  var eligibleMB = (eligibleBytes/1024/1024).toFixed(2);
  Logger.log('[R2 cleanup] 현재 R2 객체: ' + total + '개 (' + totalMB + 'MB)');
  Logger.log('  ↳ ' + CUTOFF_HOURS + '시간 이상 지난 객체: ' + eligible + '개 (' + eligibleMB + 'MB)');
  Logger.log('  ↳ 삭제 성공: ' + deleted + '개, 실패: ' + failed + '개');
  if (deletedKeys.length > 0) {
    var sample = deletedKeys.slice(0, 5);
    Logger.log('  ↳ 삭제된 키 sample: ' + sample.join(', '));
    if (deletedKeys.length > sample.length) {
      Logger.log('    (...외 ' + (deletedKeys.length - sample.length) + '개 더)');
    }
  }
}

// One-shot dry run: log how many WOULD be deleted, but don't actually delete.
function dryRunR2Cleanup() {
  var env = getEnv_();
  var cutoff = Date.now() - CUTOFF_HOURS * 3600 * 1000;
  var cursor = null;
  var total = 0, totalBytes = 0;
  var eligible = 0, eligibleBytes = 0;
  var eligibleKeys = [];

  do {
    var page = listR2_(env, cursor);
    for (var i = 0; i < page.items.length; i++) {
      var o = page.items[i];
      total++; totalBytes += o.size;
      if (o.lastModified.getTime() < cutoff) {
        eligible++; eligibleBytes += o.size;
        eligibleKeys.push(o.key);
      }
    }
    cursor = page.nextCursor;
  } while (cursor);

  var totalMB = (totalBytes/1024/1024).toFixed(2);
  var eligibleMB = (eligibleBytes/1024/1024).toFixed(2);
  Logger.log('[DRY RUN] 현재 R2 객체: ' + total + '개 (' + totalMB + 'MB)');
  Logger.log('  ↳ ' + CUTOFF_HOURS + '시간 이상 지난 객체: ' + eligible + '개 (' + eligibleMB + 'MB) — 실 실행 시 삭제 대상');
  if (eligibleKeys.length > 0) {
    var sample = eligibleKeys.slice(0, 5);
    Logger.log('  ↳ 대상 키 sample: ' + sample.join(', '));
    if (eligibleKeys.length > sample.length) {
      Logger.log('    (...외 ' + (eligibleKeys.length - sample.length) + '개 더)');
    }
  }
}

// ─── Env ──────────────────────────────────────────────────
function getEnv_() {
  var p = PropertiesService.getScriptProperties();
  var endpoint = p.getProperty('R2_ENDPOINT');
  var accessKey = p.getProperty('R2_ACCESS_KEY_ID');
  var secretKey = p.getProperty('R2_SECRET_ACCESS_KEY');
  var bucket = p.getProperty('R2_BUCKET');
  if (!endpoint || !accessKey || !secretKey || !bucket) {
    throw new Error('Script Properties missing one of: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET');
  }
  return { endpoint: endpoint.replace(/\/$/, ''), accessKey: accessKey, secretKey: secretKey, bucket: bucket };
}

// ─── R2 / S3 ops ──────────────────────────────────────────
function listR2_(env, cursor) {
  var query = { 'list-type': '2' };
  if (cursor) query['continuation-token'] = cursor;
  var path = '/' + env.bucket;
  var signed = signRequest_('GET', path, query, '', env);
  var res = UrlFetchApp.fetch(signed.url, {
    method: 'get',
    headers: signed.headers,
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('List HTTP ' + code + ' — ' + res.getContentText().substring(0, 400));
  }
  return parseListXml_(res.getContentText());
}

function deleteR2_(env, key) {
  var encoded = encodeS3Key_(key);
  var path = '/' + env.bucket + '/' + encoded;
  var signed = signRequest_('DELETE', path, {}, '', env);
  var res = UrlFetchApp.fetch(signed.url, {
    method: 'delete',
    headers: signed.headers,
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code !== 204 && code !== 200 && code !== 404) {
    throw new Error('DELETE HTTP ' + code + ' — ' + res.getContentText().substring(0, 300));
  }
}

function parseListXml_(xml) {
  var doc = XmlService.parse(xml);
  var root = doc.getRootElement();
  var ns = root.getNamespace();
  var contents = root.getChildren('Contents', ns);
  var items = [];
  for (var i = 0; i < contents.length; i++) {
    var c = contents[i];
    items.push({
      key: c.getChild('Key', ns).getText(),
      lastModified: new Date(c.getChild('LastModified', ns).getText()),
      size: parseInt(c.getChild('Size', ns).getText(), 10) || 0,
    });
  }
  var isTruncEl = root.getChild('IsTruncated', ns);
  var nextEl = root.getChild('NextContinuationToken', ns);
  var truncated = isTruncEl && isTruncEl.getText() === 'true';
  var nextCursor = (truncated && nextEl) ? nextEl.getText() : null;
  return { items: items, nextCursor: nextCursor };
}

// ─── AWS SigV4 ────────────────────────────────────────────
function signRequest_(method, path, query, body, env) {
  var url = new URL_(env.endpoint);
  var host = url.host;
  var now = new Date();
  var amzDate = toAmzDate_(now);                 // YYYYMMDDTHHMMSSZ
  var dateStamp = amzDate.substring(0, 8);       // YYYYMMDD
  var payloadHash = sha256Hex_(body || '');

  var canonicalQuery = canonicalizeQuery_(query);
  var canonicalHeaders =
        'host:' + host + '\n' +
        'x-amz-content-sha256:' + payloadHash + '\n' +
        'x-amz-date:' + amzDate + '\n';
  var signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  var canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  var canonicalHash = sha256Hex_(canonicalRequest);

  var credentialScope = dateStamp + '/' + REGION + '/' + SERVICE + '/aws4_request';
  var stringToSign = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + credentialScope + '\n' + canonicalHash;

  var signingKey = deriveSigningKey_(env.secretKey, dateStamp, REGION, SERVICE);
  var signature = hmacHex_(signingKey, stringToSign);

  var authHeader = 'AWS4-HMAC-SHA256 Credential=' + env.accessKey + '/' + credentialScope +
                   ', SignedHeaders=' + signedHeaders +
                   ', Signature=' + signature;

  var fullUrl = env.endpoint + path + (canonicalQuery ? ('?' + canonicalQuery) : '');
  return {
    url: fullUrl,
    headers: {
      'Authorization': authHeader,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
  };
}

function deriveSigningKey_(secret, dateStamp, region, service) {
  var kDate = hmacBytes_(stringToBytes_('AWS4' + secret), dateStamp);
  var kRegion = hmacBytes_(kDate, region);
  var kService = hmacBytes_(kRegion, service);
  return hmacBytes_(kService, 'aws4_request');
}

function canonicalizeQuery_(query) {
  var keys = Object.keys(query).sort();
  var parts = [];
  for (var i = 0; i < keys.length; i++) {
    parts.push(rfc3986_(keys[i]) + '=' + rfc3986_(String(query[keys[i]])));
  }
  return parts.join('&');
}

// AWS requires RFC 3986 strict encoding: only A-Z a-z 0-9 - _ . ~ are unreserved.
function rfc3986_(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

// S3 keys: encode all chars except unreserved + '/'
function encodeS3Key_(key) {
  return key.split('/').map(function (seg) { return rfc3986_(seg); }).join('/');
}

// ─── Crypto helpers ───────────────────────────────────────
function sha256Hex_(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytesToHex_(bytes);
}

function hmacBytes_(keyBytes, data) {
  return Utilities.computeHmacSha256Signature(stringToBytes_(data), keyBytes);
}

function hmacHex_(keyBytes, data) {
  return bytesToHex_(hmacBytes_(keyBytes, data));
}

function bytesToHex_(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    if (b < 0) b += 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function stringToBytes_(s) {
  // Apps Script: a string is acceptable as input but we get cleaner control via byte arrays.
  // Use UTF-8 conversion via Utilities.newBlob.
  return Utilities.newBlob(s).getBytes();
}

// ─── Misc ─────────────────────────────────────────────────
function toAmzDate_(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Tiny URL parser (Apps Script doesn't ship the URL class)
function URL_(s) {
  var m = s.match(/^(https?:)\/\/([^\/]+)(\/.*)?$/);
  if (!m) throw new Error('bad URL: ' + s);
  return { protocol: m[1], host: m[2], path: m[3] || '/' };
}
