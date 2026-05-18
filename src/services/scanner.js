const axios = require('axios');
const config = require('../../config.json');
const storage = require('../utils/storage');
const activityLogger = require('../utils/activityLogger');
const chalk = require('chalk');

class ScannerService {
    constructor() {
        this.discoveryEndpoints = [
            'https://api.dexscreener.com/community-takeovers/latest/v1',
            'https://api.dexscreener.com/token-profiles/recent-updates/v1',
            'https://api.dexscreener.com/token-profiles/latest/v1'
        ];
        this.promotionEndpoints = [
            'https://api.dexscreener.com/ads/latest/v1',
            'https://api.dexscreener.com/token-boosts/latest/v1',
            'https://api.dexscreener.com/token-boosts/top/v1'
        ];
    }

    getEndpoints() {
        const includePromotionSources = config.scanner?.includePromotionSources === true;
        return includePromotionSources
            ? [...this.discoveryEndpoints, ...this.promotionEndpoints]
            : this.discoveryEndpoints;
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
            console.log(chalk.gray(`[${new Date().toLocaleTimeString()}] Mengecek ${uniqueAddresses.size} koin dari ${this.getEndpoints().length} endpoint...`));
            if (uniqueAddresses.size === 0) {
                process.stdout.write(chalk.red(`\r[Scanner] API lambat/kosong. Mengulang...       `));
                return null;
            }

            process.stdout.write(chalk.gray(`\r[Scanner] Mengevaluasi ${uniqueAddresses.size} koin...         `));

            for (const address of uniqueAddresses) {
                const tState = state.tokenStats[address];
                if (tState) {
                    if (tState.blacklisted) continue;
                    if (tState.cooldownUntil > Date.now()) continue;
                }

                try {
                    await new Promise(resolve => setTimeout(resolve, 100));
                    const pairRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 3000 });
                    const pairs = pairRes.data.pairs;
                    if (!pairs || !Array.isArray(pairs) || pairs.length === 0) continue;

                    const solanaPair = pairs.find(p => p.chainId === 'solana');
                    if (solanaPair && this.isMatch(solanaPair)) {
                        activityLogger.log('SCANNER_MATCH', {
                            symbol: solanaPair.baseToken.symbol,
                            address: solanaPair.baseToken.address
                        });
                        return solanaPair;
                    }
                } catch (innerError) {
                    if (innerError.response && innerError.response.status === 429) {
                        console.log(chalk.red('\n[!] Rate Limit terdeteksi, istirahat 5 detik...'));
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
        const requests = this.getEndpoints().map(url => axios.get(url, { timeout: 5000 }).catch(() => null));
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
        const buys5m = txns5m.buys || 0;
        const sells5m = txns5m.sells || 0;
        const totalTx5m = buys5m + sells5m;

        if (vol5m < f.minVolume5m || buys5m < f.minBuys5m || totalTx5m === 0) return false;

        const bsRatio = sells5m > 0 ? buys5m / sells5m : buys5m;
        const sellPressureRatio = sells5m / totalTx5m;
        const netBuys5m = buys5m - sells5m;

        if (bsRatio < f.minBuySellRatio) return false;
        if (sellPressureRatio > (f.maxSellPressureRatio ?? 0.44)) return false;
        if (netBuys5m < (f.minNetBuys5m ?? 4)) return false;

        let volAccel = 1.0;
        let buyerAccel = 1.0;
        if (pairAgeMinutes > 15) {
            const cycles = Math.max(pairAgeMinutes / 5, 1);
            const avgVolPer5m = vol1h / cycles;
            volAccel = avgVolPer5m > 0 ? vol5m / avgVolPer5m : 0;

            const avgBuysPer5m = txns1h.buys / cycles;
            buyerAccel = avgBuysPer5m > 0 ? buys5m / avgBuysPer5m : 0;

            if (volAccel < f.volumeAccelRatio) return false;
            if (buyerAccel < f.buyerAccelRatio) return false;
        }

        const change1m = pair.priceChange?.m1 || 0;
        const change5m = pair.priceChange?.m5 || 0;

        if (change1m < (f.minPriceChange1m ?? 0)) return false;
        if (change5m < (f.minPriceChange5m ?? -3)) return false;
        if (change1m > f.maxPriceChange1m || change5m > f.maxPriceChange5m) return false;

        if (f.rejectPullbackAfterPump && change5m >= f.pullbackPump5mThreshold && change1m <= 0) return false;

        console.log(chalk.green(`\n[GOOD ENTRY] ${pair.baseToken.symbol} | Umur: ${pairAgeMinutes.toFixed(1)}m | Liq: $${Math.round(liq)} | Vol5m: $${vol5m} | Buys/Sells: ${buys5m}/${sells5m} | NetBuys: ${netBuys5m} | Chg1m: ${change1m.toFixed(2)}% | Chg5m: ${change5m.toFixed(2)}% | VolAccel: ${volAccel.toFixed(1)}x`));

        return true;
    }
}

module.exports = new ScannerService();