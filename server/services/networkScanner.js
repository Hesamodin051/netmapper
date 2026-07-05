const ping = require('ping');
const dns = require('dns').promises;
const net = require('net');
const HostResolver = require('./hostResolver');

// حذف وابستگی‌های ناموجود: getMACAddress, parseCIDR, lookupOUI

class NetworkScanner {
    constructor(config, macResolver) {
        this.config = config;
        this.macResolver = macResolver; // دریافت از بیرون
        this.hostResolver = new HostResolver(config);
    }

    async getHostname(ip) {
        return this.hostResolver.resolveHostname(ip);
    }

    // این متد توسط server.js صدا زده می‌شود و باید MAC را با macResolver دریافت کند
    async getMACAddress(ip) {
        // این متد در server.js پیاده‌سازی شده، اما اگر اینجا نیاز است، از macResolver استفاده کن
        // فعلاً یک placeholder
        return { address: 'Unknown', vendor: 'Unknown', countryCode: 'N/A' };
    }

    async scanPorts(ip) {
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

    // متد scanNetwork که در scan.js استفاده می‌شود
    async scanNetwork(range) {
        // این متد باید توسط server.js پیاده‌سازی شود، زیرا اسکن واقعی در server.js انجام می‌شود
        // ما اینجا فقط یک placeholder می‌گذاریم
        // در واقع server.js از توابع خودش برای اسکن استفاده می‌کند
        // اما برای سازگاری با ScanController، این متد را تعریف می‌کنیم
        throw new Error('scanNetwork must be implemented in server.js or overridden');
    }
}

module.exports = NetworkScanner;