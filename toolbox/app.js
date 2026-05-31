/* ═══════════════════════════════════════════════
   Web Toolbox — WebUSB Fastboot/ADB Engine
   ═══════════════════════════════════════════════ */

'use strict';

/* ─── State ─── */
let device = null;
let connected = false;
let mode = 'none'; // 'fastboot' | 'adb' | 'none'
let selectedPartitions = new Set();
let selectedFile = null;
let batchFiles = {};

/* ─── Fastboot USB Constants ─── */
const FASTBOOT_USB = {
  class: 0xFF,
  subclass: 0x42,
  protocol: 0x03
};

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

/* ─── WebUSB Connection ─── */
async function connectDevice() {
  try {
    logDash('正在请求 USB 设备...', 'info');

    // Request Fastboot device
    device = await navigator.usb.requestDevice({
      filters: [
        { classCode: FASTBOOT_USB.class, subclassCode: FASTBOOT_USB.subclass, protocolCode: FASTBOOT_USB.protocol }
      ]
    });

    logDash(`找到设备: ${device.productName || 'Unknown'} (${device.serialNumber})`, 'success');

    await device.open();

    // Find the correct interface
    let iface = null;
    for (const cfg of device.configurations) {
      for (const i of cfg.interfaces) {
        for (const alt of i.alternates) {
          if (alt.interfaceClass === FASTBOOT_USB.class &&
              alt.interfaceSubclass === FASTBOOT_USB.subclass &&
              alt.interfaceProtocol === FASTBOOT_USB.protocol) {
            iface = i;
            break;
          }
        }
        if (iface) break;
      }
      if (iface) break;
    }

    if (!iface) {
      logDash('未找到 Fastboot 接口', 'error');
      showToast('未找到 Fastboot 接口', 'error');
      return;
    }

    await device.selectConfiguration(1);
    await device.claimInterface(iface.interfaceNumber);

    connected = true;
    mode = 'fastboot';
    updateUI();
    logDash('Fastboot 设备已连接', 'success');
    showToast('设备已连接', 'success');

    // Get device info
    await getDeviceInfo();

  } catch (err) {
    if (err.name === 'NotFoundError') {
      logDash('用户取消了设备选择', 'warn');
    } else {
      logDash('连接失败: ' + err.message, 'error');
      showToast('连接失败: ' + err.message, 'error');
    }
  }
}

/* ─── Fastboot Command Execution ─── */
async function fastbootCommand(cmd, data = null) {
  if (!device || !connected) {
    throw new Error('设备未连接');
  }

  const encoder = new TextEncoder();
  const cmdData = encoder.encode(cmd);

  // Send command
  await device.transferOut(1, cmdData);

  // If there's data to send
  if (data) {
    // Send data length first (for download commands)
    const lenCmd = encoder.encode('download:' + data.byteLength.toString(16).padStart(8, '0'));
    await device.transferOut(1, lenCmd);

    // Wait for DATA response
    let resp = await device.transferIn(1, 64);
    const respStr = new TextDecoder().decode(resp.data);
    if (!respStr.startsWith('DATA')) {
      throw new Error('Expected DATA response, got: ' + respStr);
    }

    // Send data in chunks
    const chunkSize = 4096;
    for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
      const chunk = data.slice(offset, Math.min(offset + chunkSize, data.byteLength));
      await device.transferOut(1, chunk);
    }
  }

  // Read response
  const response = await device.transferIn(1, 64);
  return new TextDecoder().decode(response.data);
}

/* ─── Get Device Info ─── */
async function getDeviceInfo() {
  if (!connected) return;

  try {
    logDash('读取设备信息...', 'info');

    const vars = ['product', 'serialno', 'version', 'slot-count', 'variant', 'battery-voltage', 'battery-soc'];
    const info = {};

    for (const v of vars) {
      try {
        const resp = await fastbootCommand('getvar:' + v);
        info[v] = resp.replace(/^(OKAY|INFO)/, '').trim();
      } catch (e) {
        info[v] = 'N/A';
      }
    }

    // Update dashboard
    document.getElementById('dashStatus').textContent = '已连接';
    document.getElementById('dashStatus').className = 'card-value green';
    document.getElementById('dashMode').textContent = 'Fastboot 模式';
    document.getElementById('dashModel').textContent = info.product || device.productName || 'Unknown';
    document.getElementById('dashProduct').textContent = info.variant || '';
    document.getElementById('dashAndroid').textContent = info.version || '—';

    // Update device info page
    document.getElementById('infoStatus').textContent = '已连接 (Fastboot)';
    document.getElementById('infoModel').textContent = device.productName || info.product || '—';
    document.getElementById('infoProduct').textContent = info.product || '—';
    document.getElementById('infoSerial').textContent = info.serialno || device.serialNumber || '—';
    document.getElementById('infoSDK').textContent = info.version || '—';

    logDash('设备信息读取完成', 'success');

    // Try to get bootloader lock state
    try {
      const lockResp = await fastbootCommand('getvar:unlocked');
      const isUnlocked = lockResp.includes('yes');
      document.getElementById('dashLock').textContent = isUnlocked ? '已解锁' : '已锁定';
      document.getElementById('dashLock').style.color = isUnlocked ? 'var(--green)' : 'var(--amber)';
      document.getElementById('dashLockDesc').textContent = isUnlocked ? 'Bootloader 已解锁' : 'Bootloader 已锁定';
      document.getElementById('infoBootloader').textContent = isUnlocked ? '已解锁' : '已锁定';
    } catch (e) {
      document.getElementById('dashLock').textContent = '未知';
    }

  } catch (err) {
    logDash('读取设备信息失败: ' + err.message, 'error');
  }
}

async function refreshDeviceInfo() {
  await getDeviceInfo();
  showToast('设备信息已刷新', 'success');
}

/* ─── UI Updates ─── */
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
  if (device) {
    try {
      await device.close();
    } catch (e) {}
  }
  device = null;
  connected = false;
  mode = 'none';
  updateUI();
  logDash('设备已断开', 'warn');
  showToast('设备已断开', 'info');
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
    document.getElementById('selectedFile').textContent =
      `已选择: ${selectedFile.name} (${formatSize(selectedFile.size)})`;
    updateFlashButton();
  }
}

function handleBatchFileSelect(input) {
  batchFiles = {};
  const list = document.getElementById('batchFileList');
  list.innerHTML = '';

  for (const file of input.files) {
    // Try to match filename to partition name
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

  const partition = Array.from(selectedPartitions)[0];
  logFlash(`开始刷写 ${partition}...`, 'cmd');
  logFlash(`文件: ${selectedFile.name} (${formatSize(selectedFile.size)})`, 'info');

  try {
    const arrayBuffer = await selectedFile.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);

    document.getElementById('flashProgress').style.display = 'block';

    // Send flash command
    logFlash('发送 flash 命令...', 'info');
    const resp = await fastbootCommand('flash:' + partition, data);
    logFlash('响应: ' + resp, resp.includes('OKAY') ? 'success' : 'error');

    document.getElementById('flashProgressFill').style.width = '100%';

    if (resp.includes('OKAY')) {
      logFlash(`${partition} 刷写成功!`, 'success');
      showToast(`${partition} 刷写成功`, 'success');

      if (!extraArgs.includes('--skip-reboot')) {
        logFlash('正在重启设备...', 'info');
        await fastbootCommand('reboot');
      }
    } else {
      logFlash('刷写失败: ' + resp, 'error');
      showToast('刷写失败', 'error');
    }
  } catch (err) {
    logFlash('错误: ' + err.message, 'error');
    showToast('刷写错误: ' + err.message, 'error');
  }
}

async function batchFlash() {
  if (!connected || Object.keys(batchFiles).length === 0) return;

  const partitions = Object.entries(batchFiles);
  const total = partitions.length;
  let completed = 0;

  logBatch(`开始批量刷写 ${total} 个分区...`, 'cmd');
  document.getElementById('batchProgress').style.display = 'block';
  document.getElementById('btnBatchFlash').disabled = true;

  for (const [partition, file] of partitions) {
    try {
      logBatch(`[${completed + 1}/${total}] 刷写 ${partition}...`, 'info');
      const arrayBuffer = await file.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);

      const resp = await fastbootCommand('flash:' + partition, data);

      if (resp.includes('OKAY')) {
        logBatch(`  ✓ ${partition} 成功`, 'success');
      } else {
        logBatch(`  ✗ ${partition} 失败: ${resp}`, 'error');
      }
    } catch (err) {
      logBatch(`  ✗ ${partition} 错误: ${err.message}`, 'error');
    }

    completed++;
    document.getElementById('batchProgressFill').style.width = (completed / total * 100) + '%';
  }

  logBatch('批量刷写完成!', 'success');
  showToast('批量刷写完成', 'success');
  document.getElementById('btnBatchFlash').disabled = false;

  // Auto reboot
  logBatch('正在重启设备...', 'info');
  try {
    await fastbootCommand('reboot');
  } catch (e) {}
}

/* ─── Lock/Unlock ─── */
async function fastbootCmd(cmd) {
  if (!connected) {
    showToast('请先连接设备', 'error');
    return;
  }

  logLock(`执行: ${cmd}`, 'cmd');
  try {
    const resp = await fastbootCommand(cmd);
    logLock('响应: ' + resp, resp.includes('OKAY') ? 'success' : 'error');
    showToast('命令执行完成', 'success');
  } catch (err) {
    logLock('错误: ' + err.message, 'error');
    showToast('命令执行失败', 'error');
  }
}

/* ─── Terminal Command Execution ─── */
async function execCmd() {
  const input = document.getElementById('cmdInput');
  const cmd = input.value.trim();
  if (!cmd) return;

  const type = document.getElementById('cmdType').value;
  logTerm(`> ${type} ${cmd}`, 'cmd');

  if (!connected) {
    logTerm('错误: 设备未连接', 'error');
    return;
  }

  try {
    const resp = await fastbootCommand(cmd);
    logTerm(resp || '(无响应)', 'info');
  } catch (err) {
    logTerm('错误: ' + err.message, 'error');
  }

  input.value = '';
}

/* ─── Reboot Commands ─── */
async function rebootTo(mode) {
  if (!connected) {
    showToast('请先连接设备', 'error');
    return;
  }

  const cmds = {
    'system': 'reboot',
    'bootloader': 'reboot-bootloader',
    'recovery': 'reboot-recovery',
    'sideload': 'reboot-sideload',
    'edl': 'reboot-edl',
    'fastbootd': 'reboot-fastboot'
  };

  const cmd = cmds[mode] || 'reboot';
  logDash(`执行: ${cmd}`, 'cmd');

  try {
    await fastbootCommand(cmd);
    logDash('重启命令已发送', 'success');
    showToast('重启命令已发送', 'success');
  } catch (err) {
    logDash('错误: ' + err.message, 'error');
  }
}

/* ─── Drag & Drop ─── */
function setupDropZone(zoneId, handler) {
  const zone = document.getElementById(zoneId);
  if (!zone) return;

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    handler(e.dataTransfer.files);
  });
}

setupDropZone('dropZone', (files) => {
  if (files.length > 0) {
    selectedFile = files[0];
    document.getElementById('selectedFile').textContent =
      `已选择: ${selectedFile.name} (${formatSize(selectedFile.size)})`;
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
logDash('使用 WebUSB API 连接 Android 设备', 'info');
logDash('需要 Chrome/Edge 浏览器 + USB 数据线', 'info');

// Check WebUSB support
if (!navigator.usb) {
  logDash('⚠ 当前浏览器不支持 WebUSB API，请使用 Chrome 或 Edge', 'error');
  document.getElementById('btnConnect').disabled = true;
  document.getElementById('btnConnect').textContent = '浏览器不支持';
  showToast('浏览器不支持 WebUSB，请使用 Chrome/Edge', 'error');
}
