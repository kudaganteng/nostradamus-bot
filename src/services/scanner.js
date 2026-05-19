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
        this.addressSources = new Map();
    }

    getScannerConfig() {
        const s = config.scanner || {};
        return {
            includePromotionSources: s.includePromotionSources === true,
            selectionMode: s.selectionMode || 'top_random',
            topCandidateCount: Math.max(1, safeNumber(s.topCandidateCount, 5)),
            minCandidateScore: safeNumber(s.minCandidateScore, 0),
            promotionPenalty: safeNumber(s.promotionPenalty, 2),
            repeatFailurePenalty: safeNumber(s.repeatFailurePenalty, 2),
            recentCooldownPenalty: safeNumber(s.recentCooldownPenalty, 1),
            logTopCandidates: Math.max(0, safeNumber(s.logTopCandidates, 5))
        };
    }

    getEndpoints() {
        const s = this.getScannerConfig();
        const endpoints = this.discoveryEndpoints.map(url => ({ url, type: 'discovery' }));
        if (s.includePromotionSources) {
            this.promotionEndpoints.forEach(url => endpoints.push({ url, type: 'promotion' }));
        }
        return endpoints;
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
            const endpointCount = this.getEndpoints().length;
            console.log(chalk.gray(`[${new Date().toLocaleTimeString()}] Mengecek ${uniqueAddresses.size} koin dari ${endpointCount} endpoint...`));
            if (uniqueAddresses.size === 0) {
                process.stdout.write(chalk.red(`\r[Scanner] API lambat/kosong. Mengulang...       `));
                return null;
            }

            process.stdout.write(chalk.gray(`\r[Scanner] Mengevaluasi ${uniqueAddresses.size} koin...         `));
            const candidates = [];

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

                    const solanaPair = this.pickBestSolanaPair(pairs);
                    if (!solanaPair) continue;

                    const candidate = this.evaluateCandidate(solanaPair, state);
                    if (candidate.match) {
                        candidates.push(candidate);
                    }
                } catch (innerError) {
                    if (innerError.response && innerError.response.status === 429) {
                        console.log(chalk.red('\n[!] Rate Limit terdeteksi, istirahat 5 detik...'));
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                    continue;
                }
            }

            if (candidates.length === 0) return null;
            const selected = this.selectCandidate(candidates);
            activityLogger.log('SCANNER_MATCH', {
                symbol: selected.pair.baseToken.symbol,
                address: selected.pair.baseToken.address,
                score: selected.score,
                rank: selected.rank,
                candidateCount: candidates.length,
                reasons: selected.reasons
            });

            console.log(chalk.green.bold(`\n[SCANNER SELECTED] ${selected.pair.baseToken.symbol} | Score: ${selected.score.toFixed(2)} | Rank: ${selected.rank}/${candidates.length}`));
            console.log(chalk.gray(`   ${selected.reasons.join(' | ')}`));
            return selected.pair;
        } catch (error) {
            console.error(chalk.red('Scanner API Error:'), error.message);
            return null;
        }
    }

    async collectUniqueAddresses() {
        const addresses = new Set();
        this.addressSources = new Map();
        const endpoints = this.getEndpoints();
        const requests = endpoints.map(endpoint => axios.get(endpoint.url, { timeout: 5000 }).then(res => ({ res, endpoint })).catch(() => null));
        const results = await Promise.all(requests);

        results.forEach(item => {
            if (item && item.res && item.res.data) {
                const items = Array.isArray(item.res.data) ? item.res.data : (item.res.data.pairs || item.res.data.tokens || []);
                items.forEach(tokenItem => {
                    const addr = tokenItem.tokenAddress || (tokenItem.baseToken ? tokenItem.baseToken.address : null);
                    if (!addr) return;
                    addresses.add(addr);
                    const prev = this.addressSources.get(addr) || { discovery: 0, promotion: 0, urls: [] };
                    prev[item.endpoint.type] += 1;
                    prev.urls.push(item.endpoint.url);
                    this.addressSources.set(addr, prev);
                });
            }
        });
        return addresses;
    }

    pickBestSolanaPair(pairs) {
        const solanaPairs = pairs.filter(p => p.chainId === 'solana');
        if (solanaPairs.length === 0) return null;
        return solanaPairs.sort((a, b) => safeNumber(b.liquidity?.usd, 0) - safeNumber(a.liquidity?.usd, 0))[0];
    }

    evaluateCandidate(pair, state) {
        const f = config.filters;
        const address = pair.baseToken?.address;
        const sources = this.addressSources.get(address) || { discovery: 0, promotion: 0 };
        const tState = state.tokenStats?.[address] || {};
        const result = { match: false, pair, score: -999, reasons: [], metrics: {} };

        if (!pair.pairCreatedAt) return result;
        const pairAgeMinutes = (Date.now() - pair.pairCreatedAt) / (60 * 1000);
        if (pairAgeMinutes < f.minAgeMinutes || pairAgeMinutes > f.maxAgeMinutes) return result;

        const liq = safeNumber(pair.liquidity?.usd, 0);
        if (liq < f.minLiquidity || liq > f.maxLiquidity) return result;

        const vol5m = safeNumber(pair.volume?.m5, 0);
        const vol1h = safeNumber(pair.volume?.h1, 0);
        const txns5m = pair.txns?.m5 || { buys: 0, sells: 0 };
        const txns1h = pair.txns?.h1 || { buys: 0, sells: 0 };
        const buys5m = safeNumber(txns5m.buys, 0);
        const sells5m = safeNumber(txns5m.sells, 0);
        const totalTx5m = buys5m + sells5m;
        if (vol5m < f.minVolume5m || buys5m < f.minBuys5m || totalTx5m === 0) return result;

        const bsRatio = sells5m > 0 ? buys5m / sells5m : buys5m;
        const sellPressureRatio = sells5m / totalTx5m;
        const netBuys5m = buys5m - sells5m;
        if (bsRatio < f.minBuySellRatio) return result;
        if (sellPressureRatio > (f.maxSellPressureRatio ?? 0.44)) return result;
        if (netBuys5m < (f.minNetBuys5m ?? 4)) return result;

        let volAccel = 1.0;
        let buyerAccel = 1.0;
        if (pairAgeMinutes > 15) {
            const cycles = Math.max(pairAgeMinutes / 5, 1);
            const avgVolPer5m = vol1h / cycles;
            volAccel = avgVolPer5m > 0 ? vol5m / avgVolPer5m : 0;
            const avgBuysPer5m = safeNumber(txns1h.buys, 0) / cycles;
            buyerAccel = avgBuysPer5m > 0 ? buys5m / avgBuysPer5m : 0;
            if (volAccel < f.volumeAccelRatio) return result;
            if (buyerAccel < f.buyerAccelRatio) return result;
        }

        const change1m = safeNumber(pair.priceChange?.m1, 0);
        const change5m = safeNumber(pair.priceChange?.m5, 0);
        if (change1m < (f.minPriceChange1m ?? 0)) return result;
        if (change5m < (f.minPriceChange5m ?? -3)) return result;
        if (change1m > f.maxPriceChange1m || change5m > f.maxPriceChange5m) return result;
        if (f.rejectPullbackAfterPump && change5m >= f.pullbackPump5mThreshold && change1m <= 0) return result;

        const scannerConfig = this.getScannerConfig();
        let score = 0;
        const reasons = [];

        const bsScore = Math.min(bsRatio, 4) * 2;
        score += bsScore;
        reasons.push(`BS ${bsRatio.toFixed(2)}(+${bsScore.toFixed(1)})`);

        const netBuyScore = Math.min(Math.max(netBuys5m, 0), 25) * 0.25;
        score += netBuyScore;
        reasons.push(`NetBuy ${netBuys5m}(+${netBuyScore.toFixed(1)})`);

        const volScore = Math.min(Math.log10(Math.max(vol5m, 1)) - 2, 4);
        score += volScore;
        reasons.push(`Vol5m $${Math.round(vol5m)}(+${volScore.toFixed(1)})`);

        const liqScore = liq >= 5000 && liq <= 80000 ? 2 : liq > 80000 && liq <= 200000 ? 1 : 0;
        score += liqScore;
        reasons.push(`Liq $${Math.round(liq)}(+${liqScore.toFixed(1)})`);

        const momentumScore = change1m >= 0 && change1m <= 12 ? 2 : change1m > 12 && change1m <= 25 ? 1 : -1;
        score += momentumScore;
        reasons.push(`Chg1m ${change1m.toFixed(1)}%(${momentumScore >= 0 ? '+' : ''}${momentumScore})`);

        const fiveMinPenalty = change5m > 80 ? 3 : change5m > 50 ? 2 : change5m > 30 ? 1 : 0;
        score -= fiveMinPenalty;
        if (fiveMinPenalty) reasons.push(`Pump5m ${change5m.toFixed(1)}%(-${fiveMinPenalty})`);

        const sellPenalty = sellPressureRatio * 4;
        score -= sellPenalty;
        reasons.push(`SellPressure ${(sellPressureRatio * 100).toFixed(1)}%(-${sellPenalty.toFixed(1)})`);

        if (sources.promotion > 0) {
            score -= scannerConfig.promotionPenalty;
            reasons.push(`Promo(-${scannerConfig.promotionPenalty})`);
        }

        const slCount = safeNumber(tState.slCount, 0);
        if (slCount > 0) {
            const penalty = slCount * scannerConfig.repeatFailurePenalty;
            score -= penalty;
            reasons.push(`PastSL ${slCount}(-${penalty})`);
        }

        if (tState.cooldownUntil && Date.now() - tState.cooldownUntil < 10 * 60 * 1000) {
            score -= scannerConfig.recentCooldownPenalty;
            reasons.push(`RecentCooldown(-${scannerConfig.recentCooldownPenalty})`);
        }

        result.match = score >= scannerConfig.minCandidateScore;
        result.score = score;
        result.reasons = reasons;
        result.metrics = { pairAgeMinutes, liq, vol5m, buys5m, sells5m, bsRatio, sellPressureRatio, netBuys5m, volAccel, buyerAccel, change1m, change5m, sources };
        return result;
    }

    selectCandidate(candidates) {
        const scannerConfig = this.getScannerConfig();
        const sorted = candidates.sort((a, b) => b.score - a.score);
        sorted.forEach((candidate, index) => { candidate.rank = index + 1; });

        const logCount = Math.min(scannerConfig.logTopCandidates, sorted.length);
        if (logCount > 0) {
            console.log(chalk.cyan(`\n[Scanner] Top ${logCount}/${sorted.length} kandidat:`));
            sorted.slice(0, logCount).forEach((candidate, index) => {
                console.log(chalk.gray(`   #${index + 1} ${candidate.pair.baseToken.symbol} | Score ${candidate.score.toFixed(2)} | ${candidate.reasons.join(' | ')}`));
            });
        }

        if (scannerConfig.selectionMode === 'best') return sorted[0];
        const top = sorted.slice(0, Math.min(scannerConfig.topCandidateCount, sorted.length));
        return top[Math.floor(Math.random() * top.length)];
    }

    isMatch(pair) {
        return this.evaluateCandidate(pair, storage.getState()).match;
    }
}

module.exports = new ScannerService();