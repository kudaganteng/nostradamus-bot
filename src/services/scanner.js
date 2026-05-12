const axios = require('axios');
const config = require('../../config.json');
const storage = require('../utils/storage');
const activityLogger = require('../utils/activityLogger');
const chalk = require('chalk');

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
    }

    async findOpportunities() {
        try {
            // --- CEK GLOBAL PAUSE DARI RISK MANAGEMENT ---
            const state = storage.getState();
            if (state.globalPauseUntil > Date.now()) {
                const sisaMenit = Math.ceil((state.globalPauseUntil - Date.now()) / 60000);
                process.stdout.write(chalk.bgRed.white(`[GLOBAL PAUSE] Bot istirahat. Aktif kembali dalam ${sisaMenit} menit...\r`));
                return null;
            }

            const uniqueAddresses = await this.collectUniqueAddresses();
            if (uniqueAddresses.size === 0) return null;

            for (const address of uniqueAddresses) {
                // --- CEK TOKEN COOLDOWN & BLACKLIST ---
                const tState = state.tokenStats[address];
                if (tState) {
                    if (tState.blacklisted) continue; // Skip permanen
                    if (tState.cooldownUntil > Date.now()) continue; // Skip sementara
                }

                try {
                    // Delay sangat singkat untuk menghindari Rate Limit
                    await new Promise(resolve => setTimeout(resolve, 100));

                    const pairRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 3000 });
                    const pairs = pairRes.data.pairs;

                    // Pastikan pairs ada sebelum mencoba mencari solanaPair
                    if (!pairs || !Array.isArray(pairs) || pairs.length === 0) {
                        continue;
                    }

                    // Deklarasi solanaPair dengan benar di dalam scope ini
                    const solanaPair = pairs.find(p => p.chainId === 'solana');

                    // Jika koin Solana ditemukan, lempar ke fungsi isMatch
                    if (solanaPair) {
                        const isMatch = this.isMatch(solanaPair);
                        
                        if (isMatch) {
                            activityLogger.log("SCANNER_MATCH", { 
                                symbol: solanaPair.baseToken.symbol, 
                                address: solanaPair.baseToken.address 
                            });
                            return solanaPair; // Kembalikan target ke engine
                        }
                    }

                } catch (innerError) {
                    // Tangkap error API (seperti 429 Rate Limit) per koin tanpa menghentikan loop
                    if (innerError.response && innerError.response.status === 429) {
                        console.log(chalk.red("\n[!] Rate Limit terdeteksi, istirahat 5 detik..."));
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                    continue;
                }
            }

            return null; // Tidak ada koin yang match di siklus ini
        } catch (error) {
            console.error(chalk.red('Scanner API Error:'), error.message);
            return null;
        }
    }

    async collectUniqueAddresses() {
        const addresses = new Set();
        const requests = this.endpoints.map(url => axios.get(url).catch(() => null));
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
        
        // 1. FILTER UMUR
        if (pairAgeMinutes < f.minAgeMinutes || pairAgeMinutes > f.maxAgeMinutes) return false;

        // 2. FILTER LIKUIDITAS
        const liq = pair.liquidity?.usd || 0;
        if (liq < f.minLiquidity || liq > f.maxLiquidity) return false;

        // 3. FILTER TRANSAKSI & VOLUME
        const vol5m = pair.volume?.m5 || 0;
        const vol1h = pair.volume?.h1 || 0;
        const txns5m = pair.txns?.m5 || { buys: 0, sells: 0 };
        const txns1h = pair.txns?.h1 || { buys: 0, sells: 0 };

        const buys5m = txns5m.buys;
        const sells5m = txns5m.sells;

        if (vol5m < f.minVolume5m || buys5m < f.minBuys5m || sells5m === 0) return false;
        
        const bsRatio = buys5m / sells5m;
        if (bsRatio < f.minBuySellRatio) return false;

        // 4. VOLUME & BUYER ACCELERATION
        const cycles = pairAgeMinutes / 5;
        const avgVolPer5m = vol1h / cycles;
        const volAccel = avgVolPer5m > 0 ? (vol5m / avgVolPer5m) : 0;
        
        if (volAccel < f.volumeAccelRatio) return false;

        const avgBuysPer5m = txns1h.buys / cycles;
        const buyerAccel = avgBuysPer5m > 0 ? (buys5m / avgBuysPer5m) : 0;

        if (buyerAccel < f.buyerAccelRatio) return false;

        // 5. ANTI-FOMO / VERTICAL PUMP
        const change1m = pair.priceChange?.m1 || 0;
        const change5m = pair.priceChange?.m5 || 0;

        if (change1m > f.maxPriceChange1m || change5m > f.maxPriceChange5m) return false;
        
        // Visualisasi Terminal
        process.stdout.write(
            chalk.green(`\n[GOOD ENTRY] ${pair.baseToken.symbol} | Umur: ${pairAgeMinutes.toFixed(1)}m | Liq: $${Math.round(liq)} | VolAccel: ${volAccel.toFixed(1)}x\n`)
        );
        
        return true;
    }
}

module.exports = new ScannerService();