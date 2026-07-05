const express = require('express');
const dns = require('dns').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// تابع دریافت Hostname با NetBIOS
async function resolveHostnameNetBIOS(ip) {
    try {
        const { stdout } = await execAsync(`nbtstat -A ${ip}`);
        const lines = stdout.split('\n');
        for (const line of lines) {
            const match = line.match(/^(\S+)\s+<00>\s+UNIQUE/i);
            if (match) {
                return match[1].trim();
            }
        }
        return null;
    } catch (error) {
        return null;
    }
}

// تابع دسته‌بندی (مشابه server.js)
function categorizeDevice(mac, openPorts, hostname, deviceIp, isGateway, vendor) {
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

    return '❓ Unknown Device';
}

class ScanController {
    constructor(networkScanner, graphBuilder) {
        this.networkScanner = networkScanner;
        this.graphBuilder = graphBuilder;
    }

    async handleScan(req, res) {
        try {
            console.log('🔥 SCAN.JS V2.4 IS RUNNING');
            const range = req.query.range;
            const scanResults = await this.networkScanner.scanNetwork(range);
            
            if (scanResults && scanResults.devices) {
                await Promise.all(scanResults.devices.map(async (device) => {
                    if (device.ip) {
                        try {
                            device.openPorts = await this.networkScanner.scanPorts(device.ip);
                            
                            let hostname = null;
                            try {
                                hostname = await resolveHostnameNetBIOS(device.ip);
                            } catch (netbiosError) {}
                            
                            if (!hostname) {
                                try {
                                    const addresses = await dns.reverse(device.ip);
                                    if (addresses && addresses.length > 0) {
                                        hostname = addresses[0].split('.')[0];
                                    }
                                } catch (dnsError) {}
                            }
                            
                            if (hostname) {
                                device.hostname = hostname;
                            } else if (!device.hostname || device.hostname === device.ip) {
                                device.hostname = device.ip;
                            }
                            
                            device.category = categorizeDevice(
                                device.mac, 
                                device.openPorts, 
                                device.hostname || device.ip,
                                device.ip,
                                device.isGateway || false,
                                device.manufacturer?.companyName || 'Unknown'
                            );
                            
                            console.log(`✅ ${device.ip} | MAC: ${device.mac || 'N/A'} | Ports: ${device.openPorts.join(', ') || 'None'} | Category: ${device.category}`);
                            
                        } catch (portError) {
                            console.debug(`⚠️ Port scan failed for ${device.ip}:`, portError.message);
                            device.openPorts = [];
                            device.category = '❌ Scan Error';
                        }
                    }
                }));
            }
            
            const graph = this.graphBuilder.buildNetworkGraph(scanResults);
            res.json({
                nodes: graph.nodes,
                links: graph.links,
                topology: scanResults.topology || {},
                scanRange: scanResults.range || {},
                scanProgress: scanResults.progress || {}
            });
        } catch (error) {
            console.error('❌ Scan error:', error);
            res.status(500).json({
                error: error.message,
                nodes: [],
                links: []
            });
        }
    }
}

function setupScanRoutes(controller) {
    const router = express.Router();
    router.get('/', controller.handleScan.bind(controller));
    return router;
}

module.exports = {
    ScanController,
    setupScanRoutes
};