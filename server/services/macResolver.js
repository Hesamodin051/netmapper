const fs = require('fs').promises;
const https = require('https');
const path = require('path');

class MACResolver {
    constructor(config) {
        this.config = config;
        this.macDatabase = null;
        // جدا کردن دو کش
        this.ouiCache = new Map();      // برای OUI
        this.ipMacCache = new Map();    // برای (ip,mac)
        this.cacheTTL = 5 * 60 * 1000; // 5 minutes
        this.lastRequestTime = 0;
        this.minRequestInterval = 100;
        this.isInitialized = false;
        this.apiFallbackEnabled = true;
        this.apiCache = new Map();      // کش دائمی برای API
    }

    async initialize() {
        try {
            const data = await fs.readFile(this.config.database.macDbPath, 'utf8');
            this.macDatabase = JSON.parse(data);
            console.log(`Loaded ${this.macDatabase.length} MAC address entries`);
            this.isInitialized = true;
        } catch (error) {
            console.error('Failed to load MAC database:', error.message);
            this.macDatabase = [];
            this.isInitialized = true;
        }
    }

    normalizeMACAddress(mac) {
        if (!mac || mac === 'Unknown') return null;
        const normalized = mac.replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
        if (normalized.length < 6) return null;
        return normalized.slice(0, 6).match(/.{1,2}/g).join(':');
    }

    lookupOUI(mac) {
        const normalizedMAC = this.normalizeMACAddress(mac);
        if (!normalizedMAC) return null;

        if (this.ouiCache.has(normalizedMAC)) {
            return this.ouiCache.get(normalizedMAC);
        }

        const info = this.macDatabase.find(entry => {
            const entryOUI = entry.oui.replace(/[^A-Fa-f0-9]/g, '').toUpperCase().slice(0, 6);
            const checkOUI = normalizedMAC.replace(/[^A-Fa-f0-9]/g, '').slice(0, 6);
            return entryOUI === checkOUI;
        });

        this.ouiCache.set(normalizedMAC, info || null);
        return info;
    }

    // Fallback: دریافت Vendor از API آنلاین (بدون جداکننده)
    async fetchVendorFromAPI(mac) {
        return new Promise((resolve) => {
            const oui = this.normalizeMACAddress(mac);
            if (!oui) {
                resolve(null);
                return;
            }
            // حذف جداکننده‌ها برای API
            const ouiClean = oui.replace(/:/g, '');
            
            // چک کردن کش API
            if (this.apiCache.has(ouiClean)) {
                resolve(this.apiCache.get(ouiClean));
                return;
            }

            const url = `https://api.macvendors.com/${ouiClean}`;
            const request = https.get(url, (response) => {
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => {
                    if (response.statusCode === 200 && data.trim()) {
                        const result = { companyName: data.trim(), countryCode: 'N/A' };
                        this.apiCache.set(ouiClean, result);
                        resolve(result);
                    } else {
                        resolve(null);
                    }
                });
            });

            request.on('error', () => resolve(null));
            request.setTimeout(3000, () => {
                request.destroy();
                resolve(null);
            });
        });
    }

    async getVendorInfo(mac, ip) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        this.clearExpiredCaches();

        const cacheKey = `${ip}-${mac}`;
        const cached = this.ipMacCache.get(cacheKey);
        if (cached && Date.now() < cached.expires) {
            return cached.data;
        }

        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.minRequestInterval) {
            await new Promise(resolve => 
                setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest)
            );
        }
        this.lastRequestTime = Date.now();

        // جستجو در دیتابیس
        let info = this.lookupOUI(mac);
        let vendorName = info ? info.companyName : null;
        let countryCode = info ? info.countryCode : null;

        // اگر پیدا نشد و fallback فعال است، از API بگیر
        if (!vendorName && this.apiFallbackEnabled && mac && mac !== 'Unknown') {
            try {
                const apiResult = await this.fetchVendorFromAPI(mac);
                if (apiResult) {
                    vendorName = apiResult.companyName;
                    countryCode = apiResult.countryCode || 'N/A';
                    console.log(`✅ Vendor found via API for ${mac}: ${vendorName}`);
                }
            } catch (apiError) {
                console.debug(`API vendor lookup failed for ${mac}: ${apiError.message}`);
            }
        }

        const vendorInfo = {
            address: mac || 'Unknown',
            vendor: vendorName || 'Unknown',
            countryCode: countryCode || 'N/A',
            isPrivate: info ? info.isPrivate : null,
            blockType: info ? info.assignmentBlockSize : null
        };

        // ذخیره در کش ip-mac
        const ttl = vendorName ? this.cacheTTL : 60000; // 1 minute برای Unknown
        this.ipMacCache.set(cacheKey, {
            data: vendorInfo,
            expires: Date.now() + ttl
        });

        return vendorInfo;
    }

    clearExpiredCaches() {
        const now = Date.now();
        // کش ip-mac
        for (const [key, value] of this.ipMacCache) {
            if (!value || !value.expires || now > value.expires) {
                this.ipMacCache.delete(key);
            }
        }
        // API cache بدون انقضا (می‌توانید در صورت نیاز TTL اضافه کنید)
    }
}

module.exports = MACResolver;