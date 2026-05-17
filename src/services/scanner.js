const axios = require('axios');
const config = require('../../config.json');
const storage = require('../utils/storage');
const activityLogger = require('../utils/activityLogger');
const chalk = require('chalk');

function safeNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

class ScannerService {
    constructor() {
        this.endpoints = [
            'https://api.dexscreener.com/community-takeovers/latest/v1',
            'https://api.dexscreener.com/token-profiles/recent-updates/v1',
            'https://api.dexscreener.com/token-profiles/latest/v1',
            'https://api.dexscreener.com/ads/latest/v1',
            'https://api.dexscreener.com/token-boosts/latest/v1',
            'https://api.dexscreener.com/token-boosts/top/v1'
        ];
        this.localCooldown = new Map();
    }

    getScannerConfig() {
        const scanner = config.scanner || {};
        return {
            matchCooldownMinutes: Math.max(1, safeNumber(scanner.matchCooldownMinutes, 10)),
            failedObservationCooldownMinutes: Math.max(1, safeNumber(scanner.failedObservationCooldownMinutes, 10)),
            maxLocalCooldownSize: Math.max(50, safeNumber(scanner.maxLocalCooldownSize, 500))
        };
    }

    cleanupLocalCooldown() {
        const now = Date.now();
        for (const [address, until] of this.localCooldown.entries()) {
            if (!until || until <= now) this.localCooldown.delete(address);
        }

        const maxSize = this.getScannerConfig().maxLocalCooldownSize;
        if (this.localCooldown.size <= maxSize) return;

        const sorted = [...this.localCooldown.entries()].sort((a, b) => a[1] - b[1]);
        for (const [address] of sorted.slice(0, this.localCooldown.size - maxSize)) {
            this.localCooldown.delete(address);
        }
    }

    isCoolingDown(address, state = null) {
        if (!address) return false;
        const now = Date.now();
        this.cleanupLocalCooldown();

        const localUntil = this.localCooldown.get(address);
        if (localUntil && localUntil > now) return true;

        const currentState = state || storage.getState();
        const tState = currentState.tokenStats?.[address];
        if (!tState) return false;
        if (tState.blacklisted) return true;
        if (tState.cooldownUntil && tState.cooldownUntil > now) return true;
        return false;
    }

    putCooldown(address, minutes, reason = 'scanner cooldown') {
        if (!address) return;
        const until = Date.now() + minutes * 60 * 1000;
        this.localCooldown.set(address, until);

        const state = storage.getState();
        state.tokenStats = state.tokenStats || {};
        state.tokenStats[address] = state.tokenStats[address] || { slCount: 0, cooldownUntil: 0, blacklisted: false };
        state.tokenStats[address].cooldownUntil = Math.max(state.tokenStats[address].cooldownUntil || 0, until);
        storage.saveState(state);

        activityLogger.log('SCANNER_TOKEN_COOLDOWN', { address, minutes, reason });
    }

    async findOpportunities() {
        try {
            const state = storage.getState();
            if (state.globalPauseUntil > Date.now()) {
                const sisaMenit = Math.ceil((state.globalPauseUntil - Date.now()) / 60000);
                process.stdout.write(chalk.bgRed.white(`[GLOBAL PAUSE] Bot istirahat. Aktif kembali dalam ${sisaMenit} menit...\r`));
                return null;
            }

            const uniqueAddresses = await this.collectUniqueAddresses();
            console.log(chalk.gray(`[${new Date().toLocaleTimeString()}] Mengecek ${uniqueAddresses.size} koin dari 6 endpoint...`))
            if (uniqueAddresses.size === 0) {
                process.stdout.write(chalk.red(`\r[Scanner] API lambat/kosong. Mengulang...       `));
                return null;
            } else {
                process.stdout.write(chalk.gray(`\r[Scanner] Mengevaluasi ${uniqueAddresses.size} koin...         `));
            }

            for (const address of uniqueAddresses) {
                if (this.isCoolingDown(address, state)) continue;

                try {
                    await new Promise(resolve => setTimeout(resolve, 100));

                    const pairRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 3000 });
                    const pairs = pairRes.data.pairs;

                    if (!pairs || !Array.isArray(pairs) || pairs.length === 0) {
                        continue;
                    }

                    const solanaPair = pairs.find(p => p.chainId === 'solana');
                    const baseAddress = solanaPair?.baseToken?.address;

                    if (this.isCoolingDown(baseAddress, storage.getState())) continue;

                    if (solanaPair && this.isMatch(solanaPair)) {
                        const cfg = this.getScannerConfig();
                        this.putCooldown(address, cfg.matchCooldownMinutes, 'matched scanner candidate address');
                        if (baseAddress && baseAddress !== address) {
                            this.putCooldown(baseAddress, cfg.matchCooldownMinutes, 'matched scanner base token');
                        }

                        activityLogger.log("SCANNER_MATCH", {
                            symbol: solanaPair.baseToken.symbol,
                            address: solanaPair.baseToken.address,
                            cooldownMinutes: cfg.matchCooldownMinutes
                        });
                        return solanaPair;
                    }

                } catch (innerError) {
                    if (innerError.response && innerError.response.status === 429) {
                        console.log(chalk.red("\n[!] Rate Limit terdeteksi, istirahat 5 detik..."));
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                    continue;
                }
            }

            return null;
        } catch (error) {
            console.error(chalk.red('Scanner API Error:'), error.message);
            return null;
        }
    }

    async collectUniqueAddresses() {
        const addresses = new Set();
        const requests = this.endpoints.map(url => axios.get(url, { timeout: 5000 }).catch(() => null));
        const results = await Promise.all(requests);

        results.forEach(res => {
            if (res && res.data) {
                const items = Array.isArray(res.data) ? res.data : (res.data.pairs || res.data.tokens || []);
                items.forEach(item => {
                    const addr = item.tokenAddress || (item.baseToken ? item.baseToken.address : null);
                    if (addr) addresses.add(addr);
                });
            }
        });
        return addresses;
    }

    isMatch(pair) {
        const f = config.filters;

        if (!pair.pairCreatedAt) return false;
        const pairAgeMinutes = (Date.now() - pair.pairCreatedAt) / (60 * 1000);

        if (pairAgeMinutes < f.minAgeMinutes || pairAgeMinutes > f.maxAgeMinutes) return false;

        const liq = pair.liquidity?.usd || 0;
        if (liq < f.minLiquidity || liq > f.maxLiquidity) return false;

        const vol5m = pair.volume?.m5 || 0;
        const vol1h = pair.volume?.h1 || 0;
        const txns5m = pair.txns?.m5 || { buys: 0, sells: 0 };
        const txns1h = pair.txns?.h1 || { buys: 0, sells: 0 };

        const buys5m = txns5m.buys;
        const sells5m = txns5m.sells;

        if (vol5m < f.minVolume5m || buys5m < f.minBuys5m || sells5m === 0) return false;

        const bsRatio = buys5m / sells5m;
        if (bsRatio < f.minBuySellRatio) return false;

        let volAccel = 1.0;
        let buyerAccel = 1.0;

        if (pairAgeMinutes > 15) {
            const cycles = pairAgeMinutes / 5;
            const avgVolPer5m = vol1h / cycles;
            volAccel = avgVolPer5m > 0 ? (vol5m / avgVolPer5m) : 0;

            const avgBuysPer5m = txns1h.buys / cycles;
            buyerAccel = avgBuysPer5m > 0 ? (buys5m / avgBuysPer5m) : 0;
            
            if (volAccel < f.volumeAccelRatio) return false;
            if (buyerAccel < f.buyerAccelRatio) return false;
        } else {
            volAccel = 1.5;
            buyerAccel = 1.5;
        }

        const change1m = pair.priceChange?.m1 || 0;
        const change5m = pair.priceChange?.m5 || 0;

        if (change1m > (f.maxPriceChange1m * 2) || change5m > (f.maxPriceChange5m * 1.5)) return false;

        console.log(chalk.green(`\n[GOOD ENTRY] ${pair.baseToken.symbol} | Umur: ${pairAgeMinutes.toFixed(1)}m | Liq: $${Math.round(liq)} | Vol5m: $${vol5m} | Buys5m: ${buys5m} | VolAccel: ${volAccel.toFixed(1)}x`));

        return true;
    }
}

module.exports = new ScannerService();
