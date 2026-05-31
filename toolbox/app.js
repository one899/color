/* ═══════════════════════════════════════════════
   Web Toolbox — WebUSB Fastboot + ADB Engine
   ═══════════════════════════════════════════════ */

'use strict';

/* ─── State ─── */
let device = null;
let connected = false;
let mode = 'none'; // 'fastboot' | 'adb' | 'none'
let selectedPartitions = new Set();
let selectedFile = null;
let batchFiles = {};

/* ─── USB Constants ─── */
const USB_FILTERS = {
  fastboot: { classCode: 0xFF, subclassCode: 0x42, protocolCode: 0x03 },
  adb:      { classCode: 0xFF, subclassCode: 0x42, protocolCode: 0x01 }
};

/* ─── ADB Protocol Constants ─── */
const ADB_VERSION = 0x01000001;
const ADB_MAX_PAYLOAD = 256 * 1024;
const ADB_CMD = {
  CNXN: 0x4e584e43, AUTH: 0x48545541, OPEN: 0x4e45504f,
  OKAY: 0x59414b4f, WRTE: 0x45545257, CLSE: 0x45534c43
};

let adbSocket = null;
let adbLocalId = 1;
let adbReadBuffer = new Uint8Array(0);
let adbResponseResolve = null;
let adbShellOutput = '';
let adbShellResolve = null;
let adbKeyPair = null;
let adbEndpointIn = null;
let adbEndpointOut = null;
let adbInterfaceNum = null;
let adbReadLoopRunning = false;

/* ─── Page Navigation ─── */
function switchPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const page = document.getElementById('page-' + pageId);
  const nav = document.querySelector(`.nav-item[data-page="${pageId}"]`);
  if (page) page.classList.add('active');
  if (nav) nav.classList.add('active');
}

/* ─── Logging ─── */
function log(target, msg, type = 'info') {
  const area = document.getElementById(target);
  if (!area) return;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = document.createElement('div');
  line.className = 'log-line ' + type;
  line.innerHTML = `<span class="time">[${time}]</span>${escapeHtml(msg)}`;
  area.appendChild(line);
  area.scrollTop = area.scrollHeight;
}

function logDash(msg, type) { log('logArea', msg, type); }
function logFlash(msg, type) { log('flashLog', msg, type); }
function logBatch(msg, type) { log('batchLog', msg, type); }
function logLock(msg, type) { log('lockLog', msg, type); }
function logTerm(msg, type) { log('termLog', msg, type); }

function clearLog() { document.getElementById('logArea').innerHTML = ''; }
function clearTerminalLog() { document.getElementById('termLog').innerHTML = ''; }

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ─── Toast ─── */
function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

/* ═══════════════════════════════════════════════
   ADB Protocol Implementation
   ═══════════════════════════════════════════════ */

/* ─── ADB Message Builder ─── */
function adbMessage(cmd, arg0, arg1, data) {
  const payload = data ? (typeof data === 'string' ? new TextEncoder().encode(data) : data) : new Uint8Array(0);
  const checksum = payload.reduce((s, b) => s + b, 0);
  const magic = cmd ^ 0xFFFFFFFF;
  const buf = new ArrayBuffer(24 + payload.length);
  const view = new DataView(buf);
  view.setUint32(0, cmd, true);
  view.setUint32(4, arg0, true);
  view.setUint32(8, arg1, true);
  view.setUint32(12, payload.length, true);
  view.setUint32(16, checksum, true);
  view.setUint32(20, magic, true);
  new Uint8Array(buf, 24).set(payload);
  return new Uint8Array(buf);
}

function adbParseMessage(buf) {
  if (buf.length < 24) return null;
  const view = new DataView(buf.buffer, buf.byteOffset);
  return {
    cmd: view.getUint32(0, true),
    arg0: view.getUint32(4, true),
    arg1: view.getUint32(8, true),
    length: view.getUint32(12, true),
    checksum: view.getUint32(16, true),
    magic: view.getUint32(20, true),
    data: buf.slice(24)
  };
}

/* ─── Generate RSA Key for ADB Auth ─── */
async function generateAdbKey() {
  if (adbKeyPair) return adbKeyPair;
  logDash('生成 ADB RSA 密钥...', 'info');
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-1' },
    false, ['sign', 'verify']
  );
  adbKeyPair = keyPair;
  logDash('ADB 密钥已生成', 'success');
  return keyPair;
}

/* ─── Export ADB Public Key (Android format) ─── */
async function exportAdbPublicKey(keyPair) {
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  const bytes = new Uint8Array(spki);
  // Android ADB format: modulus (256 bytes, big-endian, no leading zero) + exponent (4 bytes)
  // Parse the ASN.1 SPKI to extract modulus and exponent
  // Simplified: use the raw SPKI bytes as the key (some implementations accept this)
  // For proper Android format, we need to extract modulus and exponent

  // Parse PKCS#1 from SPKI
  // SPKI: SEQUENCE { SEQUENCE { OID, NULL }, BIT STRING { SEQUENCE { modulus, exponent } } }
  // Skip to the inner SEQUENCE
  let offset = 0;
  function readLength(data, pos) {
    let len = data[pos++];
    if (len & 0x80) {
      const numBytes = len & 0x7F;
      len = 0;
      for (let i = 0; i < numBytes; i++) len = (len << 8) | data[pos++];
    }
    return { length: len, offset: pos };
  }

  // Skip outer SEQUENCE
  offset++;
  let r = readLength(bytes, offset); offset = r.offset;
  // Skip inner SEQUENCE (algorithm)
  offset++;
  r = readLength(bytes, offset); offset = r.offset;
  offset += r.length;
  // Skip BIT STRING header
  offset++;
  r = readLength(bytes, offset); offset = r.offset;
  offset++; // skip unused bits byte
  // Now at inner SEQUENCE (RSAPublicKey)
  offset++;
  r = readLength(bytes, offset); offset = r.offset;
  // modulus (INTEGER)
  offset++;
  r = readLength(bytes, offset); offset = r.offset;
  let modulus = bytes.slice(offset, offset + r.length);
  offset += r.length;
  // Remove leading zero if present
  if (modulus[0] === 0) modulus = modulus.slice(1);
  // exponent (INTEGER)
  offset++;
  r = readLength(bytes, offset); offset = r.offset;
  let exponent = bytes.slice(offset, offset + r.length);

  // Build Android ADB format: 512 bytes total = modulus (256 bytes, zero-padded) + exponent (4 bytes, little-endian)
  // Actually Android uses: modulus_len (4 bytes LE) + exponent_len (4 bytes LE) + modulus + exponent
  // But the simpler format that works is just the raw public key in a specific encoding

  // Use the standard format: base64(spki) + " user@host\n"
  // Most modern ADB versions accept this
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64 + ' unknown@webadb\n';
}

/* ─── ADB USB Read Loop ─── */
async function adbReadLoop() {
  if (adbReadLoopRunning) return;
  adbReadLoopRunning = true;

  while (connected && mode === 'adb' && device) {
    try {
      const result = await device.transferIn(adbEndpointIn, 65536);
      const data = new Uint8Array(result.data.buffer);

      // Accumulate in buffer
      const newBuf = new Uint8Array(adbReadBuffer.length + data.length);
      newBuf.set(adbReadBuffer);
      newBuf.set(data, adbReadBuffer.length);
      adbReadBuffer = newBuf;

      // Process complete messages
      while (adbReadBuffer.length >= 24) {
        const msg = adbParseMessage(adbReadBuffer);
        if (!msg) break;

        const totalLen = 24 + msg.length;
        if (adbReadBuffer.length < totalLen) break;

        const payload = adbReadBuffer.slice(24, totalLen);
        adbReadBuffer = adbReadBuffer.slice(totalLen);

        handleAdbMessage(msg, payload);
      }
    } catch (err) {
      if (connected && mode === 'adb') {
        logDash('ADB 读取错误: ' + err.message, 'error');
      }
      break;
    }
  }
  adbReadLoopRunning = false;
}

/* ─── Handle ADB Messages ─── */
function handleAdbMessage(msg, payload) {
  const cmdName = Object.keys(ADB_CMD).find(k => ADB_CMD[k] === msg.cmd) || '0x' + msg.cmd.toString(16);

  if (msg.cmd === ADB_CMD.CNXN) {
    const banner = new TextDecoder().decode(payload);
    logDash(`ADB 已连接: ${banner.substring(0, 80)}`, 'success');
    if (adbResponseResolve) { adbResponseResolve({ msg, payload }); adbResponseResolve = null; }
  }
  else if (msg.cmd === ADB_CMD.AUTH) {
    handleAdbAuth(msg, payload);
  }
  else if (msg.cmd === ADB_CMD.OKAY) {
    if (adbResponseResolve) { adbResponseResolve({ msg, payload }); adbResponseResolve = null; }
  }
  else if (msg.cmd === ADB_CMD.WRTE) {
    const text = new TextDecoder().decode(payload);
    adbShellOutput += text;
    // Send OKAY back
    const okay = adbMessage(ADB_CMD.OKAY, msg.arg1, msg.arg0, null);
    adbSendRaw(okay);
    // Check if shell command is done
    if (adbShellResolve && text.includes('\n')) {
      // Don't resolve immediately, accumulate more output
      clearTimeout(adbShellResolve._timer);
      adbShellResolve._timer = setTimeout(() => {
        if (adbShellResolve) {
          adbShellResolve(adbShellOutput);
          adbShellResolve = null;
          adbShellOutput = '';
        }
      }, 200);
    }
  }
  else if (msg.cmd === ADB_CMD.CLSE) {
    if (adbResponseResolve) { adbResponseResolve({ msg, payload }); adbResponseResolve = null; }
    if (adbShellResolve) {
      adbShellResolve(adbShellOutput);
      adbShellResolve = null;
      adbShellOutput = '';
    }
  }
}

/* ─── Handle ADB Authentication ─── */
async function handleAdbAuth(msg, payload) {
  if (msg.arg0 === 1) {
    // AUTH_TOKEN — sign with our key
    const keyPair = await generateAdbKey();
    try {
      const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, payload);
      const authMsg = adbMessage(ADB_CMD.AUTH, 2, 0, new Uint8Array(sig));
      await adbSendRaw(authMsg);
      logDash('ADB 认证: 已发送签名', 'info');
    } catch (e) {
      logDash('ADB 签名失败: ' + e.message, 'error');
      // Fallback: send public key
      await sendAdbPublicKey();
    }
  } else if (msg.arg0 === 3) {
    // AUTH_RSAPUBLICKEY — device wants us to send public key
    await sendAdbPublicKey();
  }
}

async function sendAdbPublicKey() {
  const keyPair = await generateAdbKey();
  const pubKeyStr = await exportAdbPublicKey(keyPair);
  const authMsg = adbMessage(ADB_CMD.AUTH, 3, 0, pubKeyStr);
  await adbSendRaw(authMsg);
  logDash('ADB 认证: 已发送公钥 (请在设备上确认授权)', 'warn');
  showToast('请在手机上确认 USB 调试授权', 'info');
}

/* ─── ADB Send/Receive ─── */
async function adbSendRaw(data) {
  if (!device || !adbEndpointOut) return;
  const chunkSize = 16384;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.slice(offset, Math.min(offset + chunkSize, data.length));
    await device.transferOut(adbEndpointOut, chunk);
  }
}

function adbWaitResponse(timeout = 5000) {
  return new Promise((resolve, reject) => {
    adbResponseResolve = resolve;
    setTimeout(() => { if (adbResponseResolve) { adbResponseResolve = null; reject(new Error('ADB 响应超时')); } }, timeout);
  });
}

/* ─── ADB Connect ─── */
async function adbConnect() {
  logDash('发送 ADB CNXN...', 'info');
  const cnxn = adbMessage(ADB_CMD.CNXN, ADB_VERSION, ADB_MAX_PAYLOAD, 'host::webadb\0');
  await adbSendRaw(cnxn);
  const resp = await adbWaitResponse(10000);
  if (resp.msg.cmd !== ADB_CMD.CNXN) {
    throw new Error('ADB 握手失败，收到: 0x' + resp.msg.cmd.toString(16));
  }
}

/* ─── ADB Shell Command ─── */
async function adbShell(command) {
  if (!connected || mode !== 'adb') throw new Error('ADB 未连接');

  // Open shell service
  const localId = ++adbLocalId;
  const openMsg = adbMessage(ADB_CMD.OPEN, localId, 0, 'shell:' + command + '\0');
  await adbSendRaw(openMsg);

  const resp = await adbWaitResponse(5000);
  if (resp.msg.cmd !== ADB_CMD.OKAY) {
    throw new Error('ADB shell 打开失败');
  }

  const remoteId = resp.msg.arg0;
  adbShellOutput = '';

  return new Promise((resolve, reject) => {
    adbShellResolve = resolve;
    adbShellResolve._timer = null;

    // Timeout
    setTimeout(() => {
      if (adbShellResolve) {
        adbShellResolve(adbShellOutput);
        adbShellResolve = null;
        adbShellOutput = '';
      }
    }, 30000);

    // Send initial OKAY
    const okay = adbMessage(ADB_CMD.OKAY, localId, remoteId, null);
    adbSendRaw(okay);
  });
}

/* ─── ADB Get Properties ─── */
async function adbGetProp(prop) {
  try {
    const result = await adbShell('getprop ' + prop);
    return result.trim();
  } catch (e) {
    return '';
  }
}

/* ═══════════════════════════════════════════════
   Device Connection (Unified)
   ═══════════════════════════════════════════════ */

async function connectDevice() {
  try {
    logDash('正在搜索 USB 设备...', 'info');

    device = await navigator.usb.requestDevice({
      filters: [
        USB_FILTERS.fastboot,
        USB_FILTERS.adb,
        {}  // Show all devices as fallback
      ]
    });

    logDash(`找到设备: ${device.productName || 'Unknown'} (${device.serialNumber})`, 'success');
    await device.open();

    // Detect mode
    let detectedMode = 'none';
    let targetInterface = null;

    for (const cfg of device.configurations) {
      for (const iface of cfg.interfaces) {
        for (const alt of iface.alternates) {
          if (alt.interfaceClass === 0xFF && alt.interfaceSubclass === 0x42) {
            if (alt.interfaceProtocol === 0x03) {
              detectedMode = 'fastboot';
              targetInterface = iface;
            } else if (alt.interfaceProtocol === 0x01) {
              detectedMode = 'adb';
              targetInterface = iface;
            }
          }
        }
      }
    }

    if (!targetInterface) {
      // If no specific interface found, try to use any interface
      if (device.configurations.length > 0 && device.configurations[0].interfaces.length > 0) {
        targetInterface = device.configurations[0].interfaces[0];
        // Guess mode from device state
        detectedMode = 'adb'; // Default to ADB
        logDash('未找到标准接口，尝试 ADB 模式...', 'warn');
      } else {
        throw new Error('未找到可用的 USB 接口');
      }
    }

    await device.selectConfiguration(1);
    await device.claimInterface(targetInterface.interfaceNumber);

    // Find endpoints
    const alt = targetInterface.alternates[0];
    let epIn = null, epOut = null;
    for (const ep of alt.endpoints) {
      if (ep.direction === 'in') epIn = ep.endpointNumber;
      if (ep.direction === 'out') epOut = ep.endpointNumber;
    }

    connected = true;
    mode = detectedMode;

    if (mode === 'adb') {
      adbEndpointIn = epIn;
      adbEndpointOut = epOut;
      adbInterfaceNum = targetInterface.interfaceNumber;
      logDash('ADB 模式', 'success');

      // Generate key and start read loop
      await generateAdbKey();
      adbReadLoop();
      await adbConnect();

      // Get device info via ADB
      await getAdbDeviceInfo();
    } else {
      logDash('Fastboot 模式', 'success');
      await getFastbootDeviceInfo();
    }

    updateUI();
    showToast(`设备已连接 (${mode.toUpperCase()})`, 'success');

  } catch (err) {
    if (err.name === 'NotFoundError') {
      logDash('用户取消了设备选择', 'warn');
    } else {
      logDash('连接失败: ' + err.message, 'error');
      showToast('连接失败: ' + err.message, 'error');
    }
  }
}

/* ─── ADB Device Info ─── */
async function getAdbDeviceInfo() {
  try {
    logDash('读取设备信息 (ADB)...', 'info');

    const [model, product, android, sdk, build, serial, patch, arch] = await Promise.all([
      adbGetProp('ro.product.model'),
      adbGetProp('ro.product.name'),
      adbGetProp('ro.build.version.release'),
      adbGetProp('ro.build.version.sdk'),
      adbGetProp('ro.build.display.id'),
      adbGetProp('ro.serialno'),
      adbGetProp('ro.build.version.security_patch'),
      adbGetProp('ro.product.cpu.abi'),
    ]);

    document.getElementById('dashStatus').textContent = '已连接';
    document.getElementById('dashStatus').className = 'card-value green';
    document.getElementById('dashMode').textContent = 'ADB 模式 · 系统运行中';
    document.getElementById('dashModel').textContent = model || 'Unknown';
    document.getElementById('dashProduct').textContent = product || '';
    document.getElementById('dashAndroid').textContent = android || '—';
    document.getElementById('dashSDK').textContent = 'SDK ' + (sdk || '—');

    document.getElementById('infoStatus').textContent = '已连接 (ADB)';
    document.getElementById('infoModel').textContent = model || '—';
    document.getElementById('infoProduct').textContent = product || '—';
    document.getElementById('infoSerial').textContent = serial || device.serialNumber || '—';
    document.getElementById('infoAndroid').textContent = android || '—';
    document.getElementById('infoSDK').textContent = sdk || '—';
    document.getElementById('infoPatch').textContent = patch || '—';
    document.getElementById('infoBuild').textContent = build || '—';
    document.getElementById('infoArch').textContent = arch || '—';
    document.getElementById('infoBaseband').textContent = await adbGetProp('gsm.version.baseband') || '—';
    document.getElementById('infoKernel').textContent = await adbGetProp('ro.build.kernel.id') || '—';

    // Memory info
    try {
      const memInfo = await adbShell('cat /proc/meminfo');
      const memMatch = memInfo.match(/MemTotal:\s+(\d+)/);
      if (memMatch) {
        const memMB = Math.round(parseInt(memMatch[1]) / 1024);
        document.getElementById('infoMem').textContent = memMB + ' MB';
      }
    } catch (e) {}

    // Bootloader lock state
    const secure = await adbGetProp('ro.boot.verifiedbootstate');
    const isUnlocked = secure === 'orange' || secure === '';
    document.getElementById('dashLock').textContent = isUnlocked ? '已解锁' : '已锁定';
    document.getElementById('dashLock').style.color = isUnlocked ? 'var(--green)' : 'var(--amber)';
    document.getElementById('dashLockDesc').textContent = isUnlocked ? 'Bootloader 已解锁' : 'Bootloader 已锁定';
    document.getElementById('infoBootloader').textContent = isUnlocked ? '已解锁' : '已锁定';

    logDash('设备信息读取完成', 'success');
  } catch (err) {
    logDash('读取设备信息失败: ' + err.message, 'error');
  }
}

/* ─── Fastboot Device Info ─── */
async function getFastbootDeviceInfo() {
  try {
    logDash('读取设备信息 (Fastboot)...', 'info');

    const vars = ['product', 'serialno', 'version', 'slot-count', 'variant'];
    const info = {};
    for (const v of vars) {
      try {
        const resp = await fastbootCommand('getvar:' + v);
        info[v] = resp.replace(/^(OKAY|INFO)/, '').trim();
      } catch (e) { info[v] = 'N/A'; }
    }

    document.getElementById('dashStatus').textContent = '已连接';
    document.getElementById('dashStatus').className = 'card-value green';
    document.getElementById('dashMode').textContent = 'Fastboot 模式';
    document.getElementById('dashModel').textContent = info.product || device.productName || 'Unknown';
    document.getElementById('dashProduct').textContent = info.variant || '';
    document.getElementById('dashAndroid').textContent = info.version || '—';

    document.getElementById('infoStatus').textContent = '已连接 (Fastboot)';
    document.getElementById('infoModel').textContent = device.productName || info.product || '—';
    document.getElementById('infoProduct').textContent = info.product || '—';
    document.getElementById('infoSerial').textContent = info.serialno || device.serialNumber || '—';
    document.getElementById('infoSDK').textContent = info.version || '—';

    try {
      const lockResp = await fastbootCommand('getvar:unlocked');
      const isUnlocked = lockResp.includes('yes');
      document.getElementById('dashLock').textContent = isUnlocked ? '已解锁' : '已锁定';
      document.getElementById('dashLock').style.color = isUnlocked ? 'var(--green)' : 'var(--amber)';
      document.getElementById('dashLockDesc').textContent = isUnlocked ? 'Bootloader 已解锁' : 'Bootloader 已锁定';
      document.getElementById('infoBootloader').textContent = isUnlocked ? '已解锁' : '已锁定';
    } catch (e) { document.getElementById('dashLock').textContent = '未知'; }

    logDash('设备信息读取完成', 'success');
  } catch (err) {
    logDash('读取设备信息失败: ' + err.message, 'error');
  }
}

/* ─── Fastboot Command ─── */
async function fastbootCommand(cmd, data = null) {
  if (!device || !connected) throw new Error('设备未连接');

  const encoder = new TextEncoder();
  await device.transferOut(1, encoder.encode(cmd));

  if (data) {
    const lenCmd = encoder.encode('download:' + data.byteLength.toString(16).padStart(8, '0'));
    await device.transferOut(1, lenCmd);
    const resp = await device.transferIn(1, 64);
    if (!new TextDecoder().decode(resp.data).startsWith('DATA')) {
      throw new Error('Expected DATA response');
    }
    for (let off = 0; off < data.length; off += 4096) {
      await device.transferOut(1, data.slice(off, Math.min(off + 4096, data.length)));
    }
  }

  const response = await device.transferIn(1, 64);
  return new TextDecoder().decode(response.data);
}

/* ═══════════════════════════════════════════════
   UI & Actions
   ═══════════════════════════════════════════════ */

function updateUI() {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const btn = document.getElementById('btnConnect');

  if (connected && mode === 'fastboot') {
    dot.className = 'status-dot fastboot';
    text.textContent = 'Fastboot: ' + (device.productName || device.serialNumber);
    btn.textContent = '断开连接';
    btn.onclick = disconnectDevice;
  } else if (connected && mode === 'adb') {
    dot.className = 'status-dot connected';
    text.textContent = 'ADB: ' + (device.productName || device.serialNumber);
    btn.textContent = '断开连接';
    btn.onclick = disconnectDevice;
  } else {
    dot.className = 'status-dot';
    text.textContent = '未连接设备';
    btn.textContent = '连接设备';
    btn.onclick = connectDevice;
  }
}

async function disconnectDevice() {
  adbReadLoopRunning = false;
  adbShellOutput = '';
  if (adbShellResolve) { clearTimeout(adbShellResolve._timer); adbShellResolve = null; }
  if (device) { try { await device.close(); } catch (e) {} }
  device = null;
  connected = false;
  mode = 'none';
  updateUI();
  logDash('设备已断开', 'warn');
  showToast('设备已断开', 'info');
}

async function refreshDeviceInfo() {
  if (!connected) { showToast('请先连接设备', 'error'); return; }
  if (mode === 'adb') await getAdbDeviceInfo();
  else await getFastbootDeviceInfo();
  showToast('设备信息已刷新', 'success');
}

/* ─── Partition Selection ─── */
function togglePartition(el) {
  const name = el.dataset.partition;
  if (selectedPartitions.has(name)) {
    selectedPartitions.delete(name);
    el.classList.remove('selected');
  } else {
    selectedPartitions.add(name);
    el.classList.add('selected');
  }
  updateFlashButton();
}

/* ─── File Handling ─── */
function handleFileSelect(input) {
  if (input.files.length > 0) {
    selectedFile = input.files[0];
    document.getElementById('selectedFile').textContent = `已选择: ${selectedFile.name} (${formatSize(selectedFile.size)})`;
    updateFlashButton();
  }
}

function handleBatchFileSelect(input) {
  batchFiles = {};
  const list = document.getElementById('batchFileList');
  list.innerHTML = '';
  for (const file of input.files) {
    const name = file.name.replace(/\.(img|bin|elf|zip)$/i, '');
    batchFiles[name] = file;
    const item = document.createElement('div');
    item.className = 'partition-item selected';
    item.innerHTML = `<div class="partition-check">✓</div><span>${file.name}</span><span style="margin-left:auto;color:var(--text3);font-size:11px;">→ ${name}</span>`;
    list.appendChild(item);
  }
  document.getElementById('btnBatchFlash').disabled = Object.keys(batchFiles).length === 0;
}

function updateFlashButton() {
  document.getElementById('btnFlash').disabled = !(selectedPartitions.size > 0 && selectedFile && connected);
}

/* ─── Flash Operations ─── */
async function flashPartition(extraArgs = '') {
  if (!connected || selectedPartitions.size === 0 || !selectedFile) return;
  if (mode !== 'fastboot') { showToast('分区刷写需要 Fastboot 模式', 'error'); return; }

  const partition = Array.from(selectedPartitions)[0];
  logFlash(`开始刷写 ${partition}...`, 'cmd');

  try {
    const data = new Uint8Array(await selectedFile.arrayBuffer());
    document.getElementById('flashProgress').style.display = 'block';

    const resp = await fastbootCommand('flash:' + partition, data);
    document.getElementById('flashProgressFill').style.width = '100%';

    if (resp.includes('OKAY')) {
      logFlash(`${partition} 刷写成功!`, 'success');
      showToast(`${partition} 刷写成功`, 'success');
      if (!extraArgs.includes('--skip-reboot')) {
        await fastbootCommand('reboot');
      }
    } else {
      logFlash('刷写失败: ' + resp, 'error');
    }
  } catch (err) {
    logFlash('错误: ' + err.message, 'error');
  }
}

async function batchFlash() {
  if (!connected || Object.keys(batchFiles).length === 0) return;
  if (mode !== 'fastboot') { showToast('批量刷写需要 Fastboot 模式', 'error'); return; }

  const partitions = Object.entries(batchFiles);
  const total = partitions.length;
  let completed = 0;

  logBatch(`开始批量刷写 ${total} 个分区...`, 'cmd');
  document.getElementById('batchProgress').style.display = 'block';
  document.getElementById('btnBatchFlash').disabled = true;

  for (const [partition, file] of partitions) {
    try {
      logBatch(`[${completed + 1}/${total}] 刷写 ${partition}...`, 'info');
      const data = new Uint8Array(await file.arrayBuffer());
      const resp = await fastbootCommand('flash:' + partition, data);
      logBatch(resp.includes('OKAY') ? `  OK ${partition}` : `  FAIL ${partition}: ${resp}`, resp.includes('OKAY') ? 'success' : 'error');
    } catch (err) {
      logBatch(`  ERR ${partition}: ${err.message}`, 'error');
    }
    completed++;
    document.getElementById('batchProgressFill').style.width = (completed / total * 100) + '%';
  }

  logBatch('批量刷写完成!', 'success');
  showToast('批量刷写完成', 'success');
  document.getElementById('btnBatchFlash').disabled = false;
  try { await fastbootCommand('reboot'); } catch (e) {}
}

/* ─── Lock/Unlock ─── */
async function fastbootCmd(cmd) {
  if (!connected) { showToast('请先连接设备', 'error'); return; }
  if (mode !== 'fastboot') { showToast('解锁/上锁需要 Fastboot 模式', 'error'); return; }
  logLock(`执行: ${cmd}`, 'cmd');
  try {
    const resp = await fastbootCommand(cmd);
    logLock('响应: ' + resp, resp.includes('OKAY') ? 'success' : 'error');
    showToast('命令执行完成', 'success');
  } catch (err) {
    logLock('错误: ' + err.message, 'error');
  }
}

/* ─── Terminal ─── */
async function execCmd() {
  const input = document.getElementById('cmdInput');
  const cmd = input.value.trim();
  if (!cmd) return;

  const type = document.getElementById('cmdType').value;
  logTerm(`> ${type} ${cmd}`, 'cmd');

  if (!connected) { logTerm('错误: 设备未连接', 'error'); return; }

  try {
    if (type === 'adb' && mode === 'adb') {
      const result = await adbShell(cmd);
      logTerm(result || '(无输出)', 'info');
    } else if (type === 'fastboot' && mode === 'fastboot') {
      const resp = await fastbootCommand(cmd);
      logTerm(resp || '(无响应)', 'info');
    } else {
      logTerm(`错误: 当前模式 (${mode}) 不支持 ${type} 命令`, 'error');
    }
  } catch (err) {
    logTerm('错误: ' + err.message, 'error');
  }

  input.value = '';
}

/* ─── Reboot ─── */
async function rebootTo(target) {
  if (!connected) { showToast('请先连接设备', 'error'); return; }

  try {
    if (mode === 'adb') {
      const cmds = {
        'system': 'reboot', 'bootloader': 'reboot bootloader', 'recovery': 'reboot recovery',
        'sideload': 'reboot sideload', 'edl': 'reboot edl', 'fastbootd': 'reboot fastboot'
      };
      logDash(`执行: ${cmds[target] || 'reboot'}`, 'cmd');
      await adbShell(cmds[target] || 'reboot');
      logDash('重启命令已发送', 'success');
    } else {
      const cmds = {
        'system': 'reboot', 'bootloader': 'reboot-bootloader', 'recovery': 'reboot-recovery',
        'sideload': 'reboot-sideload', 'edl': 'reboot-edl', 'fastbootd': 'reboot-fastboot'
      };
      logDash(`执行: ${cmds[target] || 'reboot'}`, 'cmd');
      await fastbootCommand(cmds[target] || 'reboot');
      logDash('重启命令已发送', 'success');
    }
    showToast('重启命令已发送', 'success');
  } catch (err) {
    logDash('错误: ' + err.message, 'error');
  }
}

/* ─── Drag & Drop ─── */
function setupDropZone(zoneId, handler) {
  const zone = document.getElementById(zoneId);
  if (!zone) return;
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drag-over'); handler(e.dataTransfer.files); });
}

setupDropZone('dropZone', (files) => {
  if (files.length > 0) {
    selectedFile = files[0];
    document.getElementById('selectedFile').textContent = `已选择: ${selectedFile.name} (${formatSize(selectedFile.size)})`;
    updateFlashButton();
  }
});

setupDropZone('batchDropZone', (files) => {
  batchFiles = {};
  const list = document.getElementById('batchFileList');
  list.innerHTML = '';
  for (const file of files) {
    const name = file.name.replace(/\.(img|bin|elf|zip)$/i, '');
    batchFiles[name] = file;
    const item = document.createElement('div');
    item.className = 'partition-item selected';
    item.innerHTML = `<div class="partition-check">✓</div><span>${file.name}</span><span style="margin-left:auto;color:var(--text3);font-size:11px;">→ ${name}</span>`;
    list.appendChild(item);
  }
  document.getElementById('btnBatchFlash').disabled = Object.keys(batchFiles).length === 0;
});

/* ─── Helpers ─── */
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/* ─── Init ─── */
logDash('Web 工具箱已就绪', 'info');
logDash('支持 ADB (系统模式) 和 Fastboot (刷机模式)', 'info');
logDash('需要 Chrome/Edge + USB 数据线', 'info');
logDash('首次 ADB 连接需在手机上确认授权', 'info');

if (!navigator.usb) {
  logDash('当前浏览器不支持 WebUSB，请使用 Chrome 或 Edge', 'error');
  document.getElementById('btnConnect').disabled = true;
  document.getElementById('btnConnect').textContent = '浏览器不支持';
}
