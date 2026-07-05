const express = require('express');
const network = require('network');
const ping = require('ping');
const arp = require('node-arp');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const app = express();
const dns = require('dns').promises;
const net = require('net');
const path = require('path');
const NetworkDiscovery = require('./server/services/networkDiscovery');
const config = require('./server/config/config');
const MACResolver = require('./server/services/macResolver');
const macResolver = new MACResolver(config);
const os = require('os');
const { Client: SSDPClient } = require('node-ssdp');
const wmi = require('node-wmi');

// ============================================================
// سیستم لاگ‌های لحظه‌ای
// ============================================================
const logBuffer = [];
const MAX_LOGS = 300;

function addLog(message, type = 'info') {
    const entry = {
        timestamp: Date.now(),
        message: message,
        type: type
    };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOGS) {
        logBuffer.shift();
    }
    console.log(message);
}

// ============================================================
// متغیرهای سراسری
// ============================================================
let allDevices = [];
let activeInterface = null;
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';
let isAutoScanRunning = false;
let autoScanInterval = null;
const AUTO_SCAN_INTERVAL_MS = 30 * 60 * 1000; // ۳۰ دقیقه

// ============================================================
// تابع دسته‌بندی دستگاه
// ============================================================
function categorizeDevice(mac, openPorts = [], hostname = '', deviceIp, isGateway = false, vendor = '') {
    const ports = openPorts || [];
    const macUpper = (mac || '').toUpperCase();
    const host = (hostname || '').toLowerCase();
    const vendorLower = (vendor || '').toLowerCase();

    if (ports.includes(9100) || host.includes('print') || host.includes('printer')) return '🖨️ Printer';
    if (isGateway) return '🌐 Router';

    const routerMacPrefixes = ['00:00:0C','00:50:7F','00:14:6C','00:18:73','00:1D:68','00:24:36'];
    if (routerMacPrefixes.some(prefix => macUpper.startsWith(prefix))) return '🌐 Router';

    if (ports.includes(445) || ports.includes(3389) || host.includes('desktop') || host.includes('laptop')) return '💻 PC (Windows)';
    if (ports.includes(22) && (ports.includes(80) || ports.includes(443))) return '🖥️ Server (Linux/Unix)';
    if (ports.includes(22)) return '🔐 SSH Server';
    if (ports.includes(80) || ports.includes(443)) return '🌍 Web Server';
    if (ports.includes(3306) || ports.includes(5432) || ports.includes(1433)) return '🗄️ Database Server';
    if (ports.includes(53)) return '🌐 DNS Server';

    const mobilePorts = [5353, 5050, 5000, 49152, 49153, 49154];
    if (ports.some(p => mobilePorts.includes(p))) return '📱 Mobile Device';
    if (macUpper.startsWith('00:50:56') || macUpper.startsWith('00:0C:29') || macUpper.startsWith('08:00:27')) return '🧩 Virtual Machine';

    const mobileMacPrefixes = [
        '88:BF:E4', '00:1E:52', '00:23:DF', 'F8:1E:DF', '00:1A:1E', '00:23:76',
        'EE:E8:B0', '00:25:00', '00:26:08', '00:27:0E', '00:16:EA', '00:19:E3',
        '00:24:36', '00:22:41', '00:24:D6', '00:26:3E', '00:1C:77', '00:23:8E',
        '00:26:9E', 'F4:92:BF', 'C8:3C:85', 'E4:5F:01', 'E8:4E:06', '00:1F:DF',
        '00:23:8F', '00:26:8F', '00:24:8F', '00:23:4E', '00:26:4E', '00:1F:3E',
        '00:23:5E', '00:26:5E', '00:1C:2E', '00:23:6E', '00:26:6E', '00:24:8E',
        '00:25:8E', '00:26:8E', '00:25:8F', '00:26:8F', '00:27:8F', '00:23:9E',
        '00:26:9E', '00:24:9E', '00:23:AE', '00:26:AE', '00:24:AE', '00:23:BE',
        '00:26:BE', '00:24:BE'
    ];
    if (mobileMacPrefixes.some(prefix => macUpper.startsWith(prefix))) return '📱 Mobile Device';

    if (ports.length === 0 && vendor && vendor !== 'Unknown') {
        const mobileVendors = ['apple', 'samsung', 'huawei', 'xiaomi', 'oppo', 'vivo', 'oneplus', 'realme', 'lg', 'sony', 'motorola', 'htc', 'nokia', 'google'];
        if (mobileVendors.some(v => vendorLower.includes(v))) {
            return '📱 Mobile Device';
        }
    }

    if (mac && mac !== 'Unknown' && ports.length === 0 && !isGateway) {
        addLog(`📱 Device ${deviceIp} detected as Mobile (heuristic)`, 'success');
        return '📱 Mobile Device';
    }

    return '❓ Unknown Device';
}

function checkOSSupport() {
    if (!isWindows && !isLinux) {
        addLog('⚠️ Unsupported operating system. Some features may not work correctly.', 'warning');
    }
    addLog(`🖥️ Running on ${process.platform} platform`, 'info');
}

function isCommandAvailable(command) {
    try {
        require('child_process').execSync(`which ${command}`, { encoding: 'utf8' });
        return true;
    } catch (error) {
        return false;
    }
}

function checkRequiredTools() {
    if (isLinux) {
        const tools = ['arp-scan', 'ip'];
        const missing = tools.filter(tool => !isCommandAvailable(tool));
        if (missing.length > 0) {
            addLog(`⚠️ Missing recommended tools: ${missing.join(', ')}`, 'warning');
        }
    }
}

async function executeCommand(command) {
    try {
        const { stdout, stderr } = await execAsync(command, { windowsHide: true, shell: true });
        return stdout;
    } catch (error) {
        throw error;
    }
}

function parseCIDR(cidr) {
    if (!cidr) return null;
    
    const [ip, bits] = cidr.split('/');
    const mask = bits ? parseInt(bits) : 24;
    
    if (mask < 16 || mask > 32) {
        throw new Error('Subnet mask must be between 16 and 32 for safety');
    }

    const ipParts = ip.split('.').map(Number);
    const networkStart = (BigInt(ipParts[0]) << 24n) + (BigInt(ipParts[1]) << 16n) + (BigInt(ipParts[2]) << 8n) + BigInt(ipParts[3]);
    const hostBits = 32 - mask;
    const totalHosts = 1n << BigInt(hostBits);
    const networkMask = ~((1n << BigInt(hostBits)) - 1n);
    const networkStartMasked = networkStart & networkMask;
    const firstHost = networkStartMasked + 1n;
    const lastHost = networkStartMasked + totalHosts - 2n;

    return {
        networkSize: Number(totalHosts),
        startAddress: `${Number((firstHost >> 24n) & 255n)}.${Number((firstHost >> 16n) & 255n)}.${Number((firstHost >> 8n) & 255n)}.${Number(firstHost & 255n)}`,
        endAddress: `${Number((lastHost >> 24n) & 255n)}.${Number((lastHost >> 16n) & 255n)}.${Number((lastHost >> 8n) & 255n)}.${Number(lastHost & 255n)}`
    };
}

function chunkArray(array, chunkSize) {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
        chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
}

function isInSubnet(ip, cidr) {
    if (!ip || !cidr) return false;
    
    const [networkAddress, bits] = cidr.split('/');
    const mask = Number(bits);
    
    const ipBinary = ip.split('.')
        .map(octet => Number(octet).toString(2).padStart(8, '0'))
        .join('');
    
    const networkBinary = networkAddress.split('.')
        .map(octet => Number(octet).toString(2).padStart(8, '0'))
        .join('');
    
    return ipBinary.substring(0, mask) === networkBinary.substring(0, mask);
}

// ============================================================
// توابع دریافت MAC
// ============================================================
async function tryArpResolution(ip) {
    try {
        const interfaces = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(interfaces)) {
            const ipv4 = addrs.find(addr => addr.family === 'IPv4' && !addr.internal);
            if (ipv4) {
                try {
                    const pingCmd = isWindows 
                        ? `ping -n 1 -w 500 ${ip}`
                        : `ping -c 1 -W 500 -I ${ipv4.address} ${ip}`;
                    await executeCommand(pingCmd);
                    await new Promise(resolve => setTimeout(resolve, 100));
                } catch (e) {}
            }
        }

        const output = await executeCommand('arp -a');
        const lines = output.split('\n');
        for (const line of lines) {
            let matches = line.match(new RegExp(`${ip}\\s+([0-9a-fA-F-]{17})`));
            if (!matches) {
                matches = line.match(new RegExp(`${ip}\\s+.*?\\s+([0-9a-fA-F:]{17})`));
            }
            if (matches && matches[1]) {
                const mac = matches[1].replace(/-/g, ':');
                return mac;
            }
        }
    } catch (e) {}
    return null;
}

async function trySnmpResolution(ip) {
    return new Promise((resolve) => {
        let isResolved = false;
        let session = null;
        try {
            const snmp = require('net-snmp');
            session = snmp.createSession(ip, 'public', { timeout: 1000, retries: 0, transport: 'udp4' });
            const oid = '1.3.6.1.2.1.2.2.1.6.2';
            session.get([oid], (error, varbinds) => {
                if (isResolved) return;
                isResolved = true;
                try { if (session) { session.close(); session = null; } } catch (closeError) {}
                if (error) { resolve(null); } else {
                    try {
                        const mac = varbinds[0]?.value?.toString('hex').match(/.{1,2}/g)?.join(':');
                        if (mac) { resolve(mac); } else { resolve(null); }
                    } catch (parseError) { resolve(null); }
                }
            });
            setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    try { if (session) { session.close(); session = null; } } catch (closeError) {}
                    resolve(null);
                }
            }, 1000);
            session.on('error', (err) => {
                if (!isResolved) {
                    isResolved = true;
                    try { if (session) { session.close(); session = null; } } catch (closeError) {}
                    resolve(null);
                }
            });
        } catch (initError) {
            if (session) { try { session.close(); } catch (closeError) {} }
            resolve(null);
        }
    });
}

async function tryWmiResolution(ip) {
    if (!isWindows) return null;
    return new Promise((resolve) => {
        try {
            const wqlQuery = {
                class: 'Win32_NetworkAdapterConfiguration',
                properties: ['MacAddress', 'IPAddress'],
                namespace: 'root\\CIMV2',
                where: `IPEnabled = true AND IPAddress IS NOT NULL`
            };
            wmi.Query(wqlQuery, (err, results) => {
                if (err) { resolve(null); return; }
                for (const adapter of results || []) {
                    if (adapter.IPAddress && Array.isArray(adapter.IPAddress)) {
                        if (adapter.IPAddress.includes(ip) && adapter.MacAddress) {
                            const mac = adapter.MacAddress.toUpperCase();
                            resolve(mac);
                            return;
                        }
                    }
                }
                resolve(null);
            });
        } catch (error) { resolve(null); }
    });
}

async function tryUpnpResolution(ip) {
    return new Promise((resolve) => {
        const client = new SSDPClient({ explicitSocketBind: true, reuseAddr: true });
        let found = false;
        client.on('response', (headers, statusCode, rinfo) => {
            if (rinfo.address === ip) {
                const usn = headers.USN;
                const macMatch = usn && usn.match(/uuid:[^:]*?([a-fA-F0-9]{12})|MAC=([a-fA-F0-9]{12})/i);
                if (macMatch) {
                    const mac = (macMatch[1] || macMatch[2]).match(/.{2}/g).join(':').toLowerCase();
                    found = true;
                    client.stop();
                    resolve(mac);
                }
            }
        });
        client.search('ssdp:all');
        setTimeout(() => {
            if (!found) {
                try { client.stop(); } catch (e) {}
                resolve(null);
            }
        }, 5000);
        client.on('error', (err) => {
            if (!found) {
                try { client.stop(); } catch (e) {}
                resolve(null);
            }
        });
    });
}

async function getLinuxMAC(ip, interfaceName) {
    let mac = 'Unknown';
    if (isCommandAvailable('arp-scan')) {
        try {
            const output = await executeCommand(`sudo arp-scan --interface=${interfaceName} --quiet --ignoredups --retry=1 --timeout=500 ${ip}`);
            const match = output.match(/([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}/);
            if (match) { mac = match[0]; return mac; }
        } catch (e) {}
    }
    try {
        const output = await executeCommand(`ip neighbor show ${ip}`);
        const match = output.match(/([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}/);
        if (match) { mac = match[0]; return mac; }
    } catch (e) {}
    try {
        const arpMac = await new Promise((resolve) => {
            arp.getMAC(ip, (err, mac) => {
                if (err) { resolve(null); } else { resolve(mac); }
            });
        });
        if (arpMac) { return arpMac; }
    } catch (e) {}
    return 'Unknown';
}

async function getWindowsMAC(ip) {
    try {
        const macFromArp = await tryArpResolution(ip);
        if (macFromArp && macFromArp !== 'Unknown') { return macFromArp; }
        const macFromSnmp = await trySnmpResolution(ip);
        if (macFromSnmp) { return macFromSnmp; }
        const macFromWmi = await tryWmiResolution(ip);
        if (macFromWmi) { return macFromWmi; }
        const macFromUpnp = await tryUpnpResolution(ip);
        if (macFromUpnp) { return macFromUpnp; }
        return 'Unknown';
    } catch (error) { return 'Unknown'; }
}

async function getMACAddress(ip) {
    if (!isWindows && !isLinux) {
        return { address: 'Unknown', vendor: 'Unknown', countryCode: 'N/A' };
    }
    let mac = 'Unknown';
    try {
        if (isLinux) {
            const interfaceName = activeInterface ? activeInterface.name : 'eth0';
            mac = await getLinuxMAC(ip, interfaceName);
        } else {
            mac = await getWindowsMAC(ip);
        }
        return await macResolver.getVendorInfo(mac, ip);
    } catch (error) {
        return { address: 'Unknown', vendor: 'Unknown', countryCode: 'N/A' };
    }
}

async function getHostname(ip) {
    try {
        const hostnames = await dns.reverse(ip);
        if (hostnames && hostnames.length > 0) { return hostnames[0]; }
    } catch (e) {}
    if (isWindows) {
        try {
            const { stdout } = await execAsync(`nbtstat -A ${ip}`);
            const lines = stdout.split('\n');
            for (const line of lines) {
                const match = line.match(/^(\S+)\s+<00>\s+UNIQUE/i);
                if (match) { return match[1].trim(); }
            }
        } catch (e) {}
    }
    return null;
}

async function scanPorts(ip) {
    const commonPorts = [21, 22, 23, 25, 53, 80, 443, 445, 3306, 3389, 5432, 8080];
    const openPorts = [];
    await Promise.all(commonPorts.map(port => {
        return new Promise(resolve => {
            const socket = new net.Socket();
            socket.setTimeout(500);
            socket.on('connect', () => {
                openPorts.push(port);
                socket.destroy();
                resolve();
            });
            socket.on('error', () => {
                socket.destroy();
                resolve();
            });
            socket.on('timeout', () => {
                socket.destroy();
                resolve();
            });
            socket.connect(port, ip);
        });
    }));
    return openPorts;
}

async function analyzeConnections(devices, topology) {
    const connections = new Map();
    const subnetGroups = new Map();
    for (const device of devices) {
        const subnet = topology.subnets.find(s => isInSubnet(device.ip, s.cidr));
        if (subnet) {
            if (!subnetGroups.has(subnet.cidr)) {
                subnetGroups.set(subnet.cidr, []);
            }
            subnetGroups.get(subnet.cidr).push(device);
        }
    }
    for (const [cidr, subnetDevices] of subnetGroups) {
        const subnet = topology.subnets.find(s => s.cidr === cidr);
        const gateway = topology.gateways.find(g => g.ip === subnet.gateway);
        if (gateway) {
            subnetDevices.forEach(device => {
                if (device.ip !== gateway.ip) {
                    connections.set(`${device.ip}-${gateway.ip}`, {
                        type: 'subnet',
                        strength: 1
                    });
                }
            });
        }
    }
    topology.routes.forEach(route => {
        if (route.via) {
            connections.set(`${route.destination}-${route.via}`, {
                type: 'route',
                strength: 0.5
            });
        }
    });
    return Array.from(connections.entries()).map(([key, value]) => {
        const [source, target] = key.split('-');
        return { source, target, ...value };
    });
}

async function scanChunk(ipList, options = {}) {
    const startTime = Date.now();
    const { chunkNum, totalChunks } = options;
    const scanProgress = {
        currentChunk: chunkNum,
        totalChunks: totalChunks,
        chunkStart: ipList[0],
        chunkEnd: ipList[ipList.length - 1],
        totalHosts: ipList.length
    };
    addLog(`📡 Scanning chunk ${chunkNum}/${totalChunks}: ${ipList[0]} to ${ipList[ipList.length-1]} (${ipList.length} hosts)`, 'scan');
    const networkDevices = [];
    const scanPromises = [];
    for (const ip of ipList) {
        if (options.activeInterface && 
            (ip === options.activeInterface.ip_address || ip === options.activeInterface.gateway_ip)) {
            continue;
        }
        scanPromises.push(
            ping.promise.probe(ip, { timeout: 2, min_reply: 1 }).then(async (res) => {
                if (res.alive) {
                    const macInfo = await getMACAddress(ip);
                    const hostname = await getHostname(ip);
                    const openPorts = await scanPorts(ip);
                    const isGateway = activeInterface && ip === activeInterface.gateway_ip;
                    const latency = res.time !== undefined ? Math.round(res.time) : 0;
                    const device = {
                        ip: ip,
                        id: ip,
                        mac: macInfo.address,
                        manufacturer: {
                            companyName: macInfo.vendor || 'Unknown',
                            countryCode: macInfo.countryCode || 'N/A'
                        },
                        name: hostname || ip,
                        hostname: hostname || ip,
                        ports: openPorts,
                        isAlive: true,
                        isGateway: isGateway,
                        latency: latency,
                        firstSeen: Date.now(),
                        category: categorizeDevice(macInfo.address, openPorts, hostname || ip, ip, isGateway, macInfo.vendor || 'Unknown')
                    };
                    networkDevices.push(device);
                    const vendorInfo = macInfo.vendor ? ` (${macInfo.vendor})` : '';
                    const portInfo = openPorts.length > 0 ? ` - ports: ${openPorts.join(', ')}` : '';
                    addLog(`✅ Found ${ip}${vendorInfo}${portInfo}`, 'success');
                }
            }).catch(err => {})
        );
    }
    await Promise.all(scanPromises);
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(1);
    addLog(`✅ Chunk ${chunkNum}/${totalChunks} completed in ${duration}s`, 'success');
    return { devices: networkDevices, progress: scanProgress, duration: duration };
}

const deviceConnections = new Map();
function startTrafficMonitoring() {
    if (isWindows) { addLog('ℹ️ Traffic monitoring is not supported on Windows', 'info'); return null; }
    if (!isLinux) { addLog('ℹ️ Traffic monitoring is only supported on Linux', 'info'); return null; }
    try {
        require('child_process').execSync('which tcpdump');
        const tcpdump = spawn('tcpdump', ['-n', '-q', '-l'], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
        tcpdump.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                const match = line.match(/(\d+\.\d+\.\d+\.\d+).*? > (\d+\.\d+\.\d+\.\d+)/);
                if (match) {
                    const [_, source, dest] = match;
                    const key = `${source}-${dest}`;
                    const count = deviceConnections.get(key) || 0;
                    deviceConnections.set(key, count + 1);
                }
            });
        });
        tcpdump.stderr.on('data', (data) => {});
        return tcpdump;
    } catch (error) {
        addLog('ℹ️ Traffic monitoring disabled: tcpdump not available', 'info');
        return null;
    }
}

// ============================================================
// به‌روزرسانی دوره‌ای وضعیت دستگاه‌ها
// ============================================================
let statusUpdateInterval = null;
let previousDeviceStatus = new Map();

async function updateDeviceStatuses() {
    if (!allDevices || allDevices.length === 0) return;
    let changes = 0;
    for (const device of allDevices) {
        try {
            const res = await ping.promise.probe(device.ip, { timeout: 1, min_reply: 1 });
            const newStatus = res.alive;
            const newLatency = res.alive ? Math.round(res.time || 0) : 0;
            const oldStatus = previousDeviceStatus.get(device.ip) ?? true;
            if (device.isAlive !== newStatus || device.latency !== newLatency) {
                device.isAlive = newStatus;
                device.latency = newLatency;
                changes++;
                if (newStatus && !oldStatus) {
                    device.firstSeen = Date.now();
                    addLog(`🟢 ${device.ip} came online (uptime reset)`, 'status');
                } else if (!newStatus && oldStatus) {
                    addLog(`🔴 ${device.ip} went offline`, 'status');
                }
                previousDeviceStatus.set(device.ip, newStatus);
            }
        } catch (err) {
            if (device.isAlive !== false) {
                device.isAlive = false;
                device.latency = 0;
                changes++;
                addLog(`🔴 ${device.ip} went offline (timeout)`, 'status');
                previousDeviceStatus.set(device.ip, false);
            }
        }
    }
    if (changes > 0) {}
}

function startStatusUpdater() {
    if (statusUpdateInterval) { clearInterval(statusUpdateInterval); }
    previousDeviceStatus.clear();
    allDevices.forEach(d => previousDeviceStatus.set(d.ip, d.isAlive));
    setTimeout(updateDeviceStatuses, 2000);
    statusUpdateInterval = setInterval(updateDeviceStatuses, 10000);
}

// ============================================================
// اسکن دوره‌ای خودکار (۳۰ دقیقه)
// ============================================================
async function performAutoScan() {
    if (isAutoScanRunning) {
        addLog('⏳ Auto-scan already in progress, skipping...', 'warning');
        return;
    }
    
    if (!activeInterface) {
        addLog('⚠️ No active interface found, skipping auto-scan', 'warning');
        return;
    }
    
    const baseIP = activeInterface.ip_address.split('.').slice(0, 3).join('.');
    const range = `${baseIP}.0/24`;
    
    isAutoScanRunning = true;
    addLog(`🔄 Running scheduled auto-scan (every 30 min) for ${range}...`, 'scan');
    
    try {
        const parsedRange = parseCIDR(range);
        if (!parsedRange) {
            throw new Error('Invalid range for auto-scan');
        }
        
        const ipList = [];
        const [startIP1, startIP2, startIP3, startIP4] = parsedRange.startAddress.split('.').map(Number);
        const [endIP1, endIP2, endIP3, endIP4] = parsedRange.endAddress.split('.').map(Number);
        
        for (let i1 = startIP1; i1 <= endIP1; i1++) {
            for (let i2 = (i1 === startIP1 ? startIP2 : 0); i2 <= (i1 === endIP1 ? endIP2 : 255); i2++) {
                for (let i3 = (i1 === startIP1 && i2 === startIP2 ? startIP3 : 0); 
                     i3 <= (i1 === endIP1 && i2 === endIP2 ? endIP3 : 255); i3++) {
                    for (let i4 = (i1 === startIP1 && i2 === startIP2 && i3 === startIP3 ? startIP4 : 1);
                         i4 <= (i1 === endIP1 && i2 === endIP2 && i3 === endIP3 ? endIP4 : 254); i4++) {
                        ipList.push(`${i1}.${i2}.${i3}.${i4}`);
                    }
                }
            }
        }
        
        const localIP = activeInterface ? activeInterface.ip_address : null;
        const filteredIpList = localIP ? ipList.filter(ip => ip !== localIP) : ipList;
        
        const chunks = chunkArray(filteredIpList, config.scanner.maxChunkSize);
        const allDevicesTemp = [];
        
        for (let i = 0; i < chunks.length; i++) {
            const chunkResult = await scanChunk(chunks[i], { 
                activeInterface,
                chunkNum: i + 1,
                totalChunks: chunks.length
            });
            allDevicesTemp.push(...chunkResult.devices);
            if (i < chunks.length - 1) {
                await new Promise(resolve => setTimeout(resolve, config.scanner.chunkDelay));
            }
        }
        
        const oldDevices = new Set(allDevices.map(d => d.ip));
        const newDevices = allDevicesTemp.filter(d => !oldDevices.has(d.ip));
        
        if (newDevices.length > 0) {
            addLog(`🆕 Auto-scan found ${newDevices.length} new device(s): ${newDevices.map(d => d.ip).join(', ')}`, 'success');
        }
        
        if (allDevicesTemp.length > 0) {
            allDevices = allDevicesTemp;
            startStatusUpdater();
            addLog(`✅ Auto-scan complete. Total: ${allDevices.length} devices.`, 'success');
        } else {
            addLog('⚠️ Auto-scan found no devices', 'warning');
        }
        
    } catch (error) {
        addLog(`❌ Auto-scan failed: ${error.message}`, 'error');
    } finally {
        isAutoScanRunning = false;
    }
}

function startAutoScan() {
    if (autoScanInterval) {
        clearInterval(autoScanInterval);
    }
    
    setTimeout(() => {
        performAutoScan();
    }, 10000);
    
    autoScanInterval = setInterval(performAutoScan, AUTO_SCAN_INTERVAL_MS);
    addLog('🔄 Auto-scan enabled (every 30 minutes)', 'info');
}

// ============================================================
// مسیرهای API
// ============================================================
app.use(express.static('public'));

app.get('/api/logs', (req, res) => {
    const since = req.query.since ? parseInt(req.query.since) : 0;
    const newLogs = logBuffer.filter(log => log.timestamp > since);
    const latestTimestamp = logBuffer.length > 0 ? logBuffer[logBuffer.length - 1].timestamp : 0;
    res.json({ logs: newLogs, latestTimestamp });
});

app.get('/api/network/topology', async (req, res) => {
    try {
        const discovery = new NetworkDiscovery(config);
        const topology = await discovery.discover();
        res.json(topology);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/status', (req, res) => {
    if (!allDevices || allDevices.length === 0) {
        return res.json({ devices: [] });
    }
    const status = allDevices.map(device => ({
        ip: device.ip,
        isAlive: device.isAlive,
        latency: device.latency || 0
    }));
    res.json({ devices: status });
});

// ============================================================
// ===== تحلیل امنیتی =====
// ============================================================
app.get('/api/security-check', async (req, res) => {
    const ip = req.query.ip;
    if (!ip) {
        return res.status(400).json({ error: 'IP address is required' });
    }

    try {
        const response = await fetch(`https://internetdb.shodan.io/${ip}`);
        
        if (!response.ok) {
            if (response.status === 404) {
                return res.json({ 
                    ip: ip,
                    message: 'No public information found for this IP',
                    ports: [],
                    cves: [],
                    vulns: []
                });
            }
            throw new Error(`Shodan API error: ${response.status}`);
        }

        const data = await response.json();
        
        const result = {
            ip: data.ip || ip,
            ports: data.ports || [],
            cpes: data.cpes || [],
            hostnames: data.hostnames || [],
            vulns: data.vulns || [],
            tags: data.tags || []
        };

        if (result.vulns && result.vulns.length > 0) {
            const cveDetails = [];
            for (const cveId of result.vulns) {
                try {
                    const cveResponse = await fetch(`https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${cveId}`);
                    if (cveResponse.ok) {
                        const cveData = await cveResponse.json();
                        const cve = cveData.vulnerabilities?.[0]?.cve;
                        if (cve) {
                            cveDetails.push({
                                id: cve.id,
                                description: cve.descriptions?.[0]?.value || 'No description available',
                                cvss: cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseScore || 'N/A',
                                severity: cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseSeverity || 'N/A',
                                published: cve.published || 'N/A',
                                references: cve.references?.[0]?.url || 'N/A'
                            });
                        }
                    }
                } catch (cveError) {
                    console.debug(`Failed to fetch details for ${cveId}:`, cveError.message);
                }
            }
            result.cveDetails = cveDetails;
        }

        addLog(`🔍 Security check completed for ${ip} (${result.vulns?.length || 0} CVEs found)`, 'info');
        res.json(result);

    } catch (error) {
        console.error('Security check error:', error);
        res.status(500).json({ 
            error: 'Failed to check security',
            message: error.message 
        });
    }
});

// ============================================================
// مسیر اسکن اصلی
// ============================================================
app.get('/api/scan', async (req, res) => {
    try {
        const customRange = req.query.range;
        let scanRange;
        addLog(`🔍 Starting network scan for range: ${customRange}`, 'scan');
        if (customRange) {
            const parsedRange = parseCIDR(customRange);
            if (!parsedRange) { throw new Error('Invalid IP range'); }
            if (parsedRange.networkSize > config.scanner.maxTotalSize) {
                throw new Error(`Network size too large. Maximum allowed is ${config.scanner.maxTotalSize} hosts.`);
            }
            scanRange = { startIP: parsedRange.startAddress, endIP: parsedRange.endAddress, ipList: [] };
            const [startIP1, startIP2, startIP3, startIP4] = parsedRange.startAddress.split('.').map(Number);
            const [endIP1, endIP2, endIP3, endIP4] = parsedRange.endAddress.split('.').map(Number);
            for (let i1 = startIP1; i1 <= endIP1; i1++) {
                for (let i2 = (i1 === startIP1 ? startIP2 : 0); i2 <= (i1 === endIP1 ? endIP2 : 255); i2++) {
                    for (let i3 = (i1 === startIP1 && i2 === startIP2 ? startIP3 : 0); 
                         i3 <= (i1 === endIP1 && i2 === endIP2 ? endIP3 : 255); i3++) {
                        for (let i4 = (i1 === startIP1 && i2 === startIP2 && i3 === startIP3 ? startIP4 : 1);
                             i4 <= (i1 === endIP1 && i2 === endIP2 && i3 === endIP3 ? endIP4 : 254); i4++) {
                            scanRange.ipList.push(`${i1}.${i2}.${i3}.${i4}`);
                        }
                    }
                }
            }
            const localIP = activeInterface ? activeInterface.ip_address : null;
            if (localIP) {
                scanRange.ipList = scanRange.ipList.filter(ip => ip !== localIP);
                addLog(`ℹ️ Excluding local IP ${localIP} from scan`, 'info');
            }
            addLog(`📊 Total hosts to scan: ${scanRange.ipList.length}`, 'scan');
            const chunks = chunkArray(scanRange.ipList, config.scanner.maxChunkSize);
            const allDevicesTemp = [];
            let lastProgress = null;
            for (let i = 0; i < chunks.length; i++) {
                const chunkResult = await scanChunk(chunks[i], { 
                    activeInterface,
                    chunkNum: i + 1,
                    totalChunks: chunks.length
                });
                allDevicesTemp.push(...chunkResult.devices);
                lastProgress = chunkResult.progress;
                if (i < chunks.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, config.scanner.chunkDelay));
                }
            }
            if (activeInterface && activeInterface.mac_address) {
                const selfDevice = {
                    ip: activeInterface.ip_address,
                    id: activeInterface.ip_address,
                    mac: activeInterface.mac_address,
                    manufacturer: { companyName: 'Local Host', countryCode: 'N/A' },
                    name: os.hostname() || activeInterface.ip_address,
                    hostname: os.hostname() || activeInterface.ip_address,
                    ports: [],
                    isAlive: true,
                    isGateway: false,
                    latency: 0,
                    firstSeen: Date.now(),
                    category: '💻 Local Host'
                };
                allDevicesTemp.push(selfDevice);
                addLog(`💻 Added local device: ${activeInterface.ip_address} (${os.hostname() || 'Unknown'})`, 'info');
            }
            if (allDevicesTemp.length > 0) {
                allDevices = allDevicesTemp;
                startStatusUpdater();
            }
            addLog(`✅ Scan complete. Found ${allDevicesTemp.length} devices.`, 'success');
            const discovery = new NetworkDiscovery(config);
            const topology = await discovery.discover();
            const connections = await analyzeConnections(allDevicesTemp, topology);
            const updatedNodes = allDevicesTemp.map(device => {
                const subnet = topology.subnets.find(s => isInSubnet(device.ip, s.cidr));
                return {
                    ...device,
                    subnet: subnet ? subnet.cidr : null,
                    isGateway: topology.gateways.some(g => g.ip === device.ip)
                };
            });
            res.json({ 
                nodes: updatedNodes,
                links: connections,
                topology,
                scanRange,
                scanProgress: lastProgress
            });
        } else {
            const interfaces = await new Promise((resolve, reject) => {
                network.get_interfaces_list((err, interfaces) => {
                    if (err) reject(err);
                    else resolve(interfaces);
                });
            });
            activeInterface = interfaces.find(i => i.ip_address && (i.type === 'Wired' || i.type === 'Wireless'));
            if (!activeInterface) { throw new Error('No active network interface found'); }
            addLog(`🌐 Active interface: ${activeInterface.type} - ${activeInterface.ip_address} (Gateway: ${activeInterface.gateway_ip})`, 'info');
            if (!activeInterface.gateway_ip) { throw new Error('No gateway IP found'); }
            const baseIP = activeInterface.ip_address.split('.');
            scanRange = { baseIP: baseIP.slice(0, 3).join('.'), startHost: 1, endHost: 254 };
            addLog(`📊 Scanning range: ${scanRange.baseIP}.${scanRange.startHost} to ${scanRange.baseIP}.${scanRange.endHost}`, 'scan');
            const networkDevices = [];
            const scanPromises = [];
            for (let i = scanRange.startHost; i <= scanRange.endHost; i++) {
                const ip = `${scanRange.baseIP}.${i}`;
                if (activeInterface && (ip === activeInterface.ip_address || ip === activeInterface.gateway_ip)) {
                    continue;
                }
                scanPromises.push(
                    ping.promise.probe(ip, { timeout: 2, min_reply: 1 }).then(async (res) => {
                        if (res.alive) {
                            const macInfo = await getMACAddress(ip);
                            const hostname = await getHostname(ip);
                            const openPorts = await scanPorts(ip);
                            const isGateway = activeInterface && ip === activeInterface.gateway_ip;
                            const latency = res.time !== undefined ? Math.round(res.time) : 0;
                            const device = {
                                ip: ip,
                                id: ip,
                                mac: macInfo.address,
                                manufacturer: {
                                    companyName: macInfo.vendor || 'Unknown',
                                    countryCode: macInfo.countryCode || 'N/A'
                                },
                                name: hostname || ip,
                                hostname: hostname || ip,
                                ports: openPorts,
                                isAlive: true,
                                isGateway: isGateway,
                                latency: latency,
                                firstSeen: Date.now(),
                                category: categorizeDevice(macInfo.address, openPorts, hostname || ip, ip, isGateway, macInfo.vendor || 'Unknown')
                            };
                            networkDevices.push(device);
                            const vendorInfo = macInfo.vendor ? ` (${macInfo.vendor})` : '';
                            const portInfo = openPorts.length > 0 ? ` - ports: ${openPorts.join(', ')}` : '';
                            addLog(`✅ Found ${ip}${vendorInfo}${portInfo}`, 'success');
                        }
                    })
                );
            }
            await Promise.all(scanPromises);
            if (networkDevices.length === 0) {
                addLog('⚠️ No devices found in the network', 'warning');
                res.json({ nodes: [], links: [], scanRange: { start: `${scanRange.baseIP}.${scanRange.startHost}`, end: `${scanRange.baseIP}.${scanRange.endHost}`, total: scanRange.endHost - scanRange.startHost + 1 } });
                return;
            }
            if (networkDevices.length > 0) {
                allDevices = networkDevices;
                startStatusUpdater();
            }
            addLog(`✅ Scan complete. Found ${networkDevices.length} devices.`, 'success');
            const discovery = new NetworkDiscovery(config);
            const topology = await discovery.discover();
            const connections = await analyzeConnections(networkDevices, topology);
            const updatedNodes = networkDevices.map(device => {
                const subnet = topology.subnets.find(s => isInSubnet(device.ip, s.cidr));
                return {
                    ...device,
                    subnet: subnet ? subnet.cidr : null,
                    isGateway: topology.gateways.some(g => g.ip === device.ip)
                };
            });
            res.json({ nodes: updatedNodes, links: connections, topology, scanRange });
        }
    } catch (error) {
        addLog(`❌ Scan error: ${error.message}`, 'error');
        res.status(500).json({ error: error.message, stack: error.stack, nodes: [], links: [] });
    }
});

app.get('/api/connections', (req, res) => {
    if (process.platform === 'win32' || !deviceConnections.size) {
        res.json([]);
        return;
    }
    const connections = [];
    deviceConnections.forEach((count, key) => {
        const [source, target] = key.split('-');
        connections.push({ source, target, count });
    });
    res.json(connections);
});

// ============================================================
// راه‌اندازی نهایی سرور و اسکن خودکار
// ============================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await macResolver.initialize();
    checkOSSupport();
    checkRequiredTools();
    const monitor = startTrafficMonitoring();
    if (!monitor) {}
    
    setTimeout(() => {
        network.get_interfaces_list(async (err, interfaces) => {
            if (err) return;
            const iface = interfaces.find(i => i.ip_address && (i.type === 'Wired' || i.type === 'Wireless'));
            if (iface) {
                activeInterface = iface;
                startAutoScan();
            } else {
                addLog('⚠️ No active interface found, auto-scan disabled', 'warning');
            }
        });
    }, 3000);
});