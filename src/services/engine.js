const axios = require('axios');
const chalk = require('chalk');
const config = require('../../config.json');
const telegram = require('./telegram');
const storage = require('../utils/storage');
const activityLogger = require('../utils/activityLogger');
const { Connection, PublicKey } = require('@solana/web3.js');
require('dotenv').config();

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS = 9;

function safeNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clampNumber(value, min, max, fallback = min) {
    const n = safeNumber(value, fallback);
    return Math.min(Math.max(n, min), max);
}

function clampProbability(value, fallback = 0) {
    const n = safeNumber(value, fallback);
    return Math.min(Math.max(n, 0), 1);
}

function bpsToMultiplier(bps) {
    return safeNumber(bps, 0) / 10000;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getAlchemyRpcUrl() {
    const url = process.env.ALCHEMY_RPC_URL;
    if (!url || !url.trim()) throw new Error('ALCHEMY_RPC_URL belum diisi. Tambahkan ALCHEMY_RPC_URL ke file .env.');
    return url.trim();
}

class EngineService {
    constructor() {
        storage.init();
        this.alchemyRpcUrl = getAlchemyRpcUrl();
        this.connection = new Connection(this.alchemyRpcUrl, 'confirmed');
        this.pairEndpoint = 'https://api.dexscreener.com/latest/dex/pairs/solana/';
        this.decimalsCache = new Map();
        this.isPolling = false;
        this.checkInterval = null;
        this.hasRecovered = false;
        this.currentPosition = storage.loadActivePosition();

        if (this.currentPosition) {
            console.log(chalk.yellow.bold('\n[RECOVERY] Melanjutkan monitoring posisi yang terbuka...'));
            this.startMonitoring();
            this.hasRecovered = true;
        }
    }

    getPriceMonitoringConfig() {
        const pm = config.priceMonitoring || {};
        return {
            source: pm.source || 'dexscreener',
            activeIntervalMs: Math.max(250, safeNumber(pm.activeIntervalMs, 750)),
            observationIntervalMs: Math.max(250, safeNumber(pm.observationIntervalMs, 750)),
            timeoutMs: Math.max(300, safeNumber(pm.timeoutMs, 3000)),
            minDelayMs: Math.max(50, safeNumber(pm.minDelayMs, 150)),
            validateOnChainOnce: pm.validateOnChainOnce !== false,
            fallbackToDexScreener: pm.fallbackToDexScreener !== false,
            jupiterQuoteUrl: pm.jupiterQuoteUrl || 'https://quote-api.jup.ag/v6/quote',
            jupiterSlippageBps: Math.max(1, safeNumber(pm.jupiterSlippageBps, 100)),
            jupiterOnlyDirectRoutes: pm.jupiterOnlyDirectRoutes === true,
            assumedSolUsd: Math.max(1, safeNumber(pm.assumedSolUsd, 150))
        };
    }

    getDailyRiskConfig() {
        const dr = config.dailyRisk || {};
        return {
            enabled: dr.enabled === true,
            maxDailyLossSol: Math.max(0, safeNumber(dr.maxDailyLossSol, 0.15)),
            maxDailyLossPercent: Math.max(0, safeNumber(dr.maxDailyLossPercent, 15)),
            pauseMinutesAfterDailyLoss: Math.max(1, safeNumber(dr.pauseMinutesAfterDailyLoss, 1440))
        };
    }

    getPositionSizingConfig() {
        const ps = config.positionSizing || {};
        return {
            enabled: ps.enabled === true,
            baseSizeSol: Math.max(0, safeNumber(ps.baseSizeSol, config.trading.positionSize)),
            minSizeSol: Math.max(0, safeNumber(ps.minSizeSol, 0.05)),
            maxSizeSol: Math.max(0, safeNumber(ps.maxSizeSol, config.trading.positionSize)),
            flatObservationMultiplier: safeNumber(ps.flatObservationMultiplier, 0.5),
            lowLiquidityMultiplier: safeNumber(ps.lowLiquidityMultiplier, 0.6),
            highVolatilityMultiplier: safeNumber(ps.highVolatilityMultiplier, 0.7),
            drawdownMultiplier: safeNumber(ps.drawdownMultiplier, 0.6),
            losingStreakMultiplier: safeNumber(ps.losingStreakMultiplier, 0.5),
            tokenScorePenaltyMultiplier: safeNumber(ps.tokenScorePenaltyMultiplier, 0.7),
            lowLiquidityThresholdUsd: safeNumber(ps.lowLiquidityThresholdUsd, 10000),
            highVolatilityThreshold: safeNumber(ps.highVolatilityThreshold, 1.5),
            drawdownThresholdPercent: safeNumber(ps.drawdownThresholdPercent, 7),
            losingStreakCount: Math.max(1, safeNumber(ps.losingStreakCount, 2)),
            badTokenScoreThreshold: safeNumber(ps.badTokenScoreThreshold, 0)
        };
    }

    getPaperExecutionConfig() {
        const pe = config.paperExecution || {};
        return {
            enabled: pe.enabled !== false,
            dynamicSlippage: pe.dynamicSlippage !== false,
            buySlippageBps: safeNumber(pe.buySlippageBps, 0),
            sellSlippageBps: safeNumber(pe.sellSlippageBps, 0),
            baseBuySlippageBps: safeNumber(pe.baseBuySlippageBps ?? pe.buySlippageBps, 40),
            baseSellSlippageBps: safeNumber(pe.baseSellSlippageBps ?? pe.sellSlippageBps, 70),
            minBuySlippageBps: safeNumber(pe.minBuySlippageBps, 25),
            maxBuySlippageBps: safeNumber(pe.maxBuySlippageBps, 350),
            minSellSlippageBps: safeNumber(pe.minSellSlippageBps, 40),
            maxSellSlippageBps: safeNumber(pe.maxSellSlippageBps, 650),
            volatilitySlippageMultiplier: safeNumber(pe.volatilitySlippageMultiplier, 55),
            priceRangeSlippageMultiplier: safeNumber(pe.priceRangeSlippageMultiplier, 8),
            lowLiquidityThresholdUsd: safeNumber(pe.lowLiquidityThresholdUsd, 10000),
            lowLiquiditySlippageBps: safeNumber(pe.lowLiquiditySlippageBps, 140),
            sizeImpactMultiplier: safeNumber(pe.sizeImpactMultiplier, 120),
            randomJitterBps: safeNumber(pe.randomJitterBps, 35),
            dexFeeBps: safeNumber(pe.dexFeeBps, 0),
            networkFeeSol: safeNumber(pe.networkFeeSol, 0),
            priorityFeeSol: safeNumber(pe.priorityFeeSol, 0),
            baseBuyFailureChance: clampProbability(pe.baseBuyFailureChance, clampProbability(pe.buyFailureChance, 0.03)),
            baseSellFailureChance: clampProbability(pe.baseSellFailureChance, clampProbability(pe.sellFailureChance, 0.05)),
            failureChancePer100BpsSlippage: safeNumber(pe.failureChancePer100BpsSlippage, 0.01),
            maxBuyFailureChance: clampProbability(pe.maxBuyFailureChance, 0.12),
            maxSellFailureChance: clampProbability(pe.maxSellFailureChance, 0.22),
            maxSellFailureRetries: Math.max(0, safeNumber(pe.maxSellFailureRetries, 0)),
            sellRetryPenaltyBps: safeNumber(pe.sellRetryPenaltyBps, 0)
        };
    }

    getAdaptiveRiskConfig() {
        const ar = config.adaptiveRisk || {};
        return {
            maxAllowedVolatility: safeNumber(ar.maxAllowedVolatility, 3.5),
            flatObservation: ar.flatObservation || {},
            profitLockTiers: Array.isArray(ar.profitLockTiers) ? ar.profitLockTiers : [],
            earlyExitRules: Array.isArray(ar.earlyExitRules) ? ar.earlyExitRules : [],
            earlyExitMaxPnlThreshold: safeNumber(ar.earlyExitMaxPnlThreshold, 0),
            minPnlAfterSeconds: safeNumber(ar.minPnlAfterSeconds, 0),
            minPnlRequired: safeNumber(ar.minPnlRequired, 0),
            stagnationRules: Array.isArray(ar.stagnationRules) ? ar.stagnationRules : [],
            maxStopLossCountBeforeCooldown: safeNumber(ar.maxStopLossCountBeforeCooldown, 3),
            extendedCooldownHours: safeNumber(ar.extendedCooldownHours, 12),
            sessionBlacklistStopLossCount: safeNumber(ar.sessionBlacklistStopLossCount, 5),
            minTokenScore: safeNumber(ar.minTokenScore, -2),
            maxPortfolioDrawdownPercent: safeNumber(ar.maxPortfolioDrawdownPercent, 10),
            recentTradeCount: safeNumber(ar.recentTradeCount, 5),
            recentTradesMaxTotalPnlPercent: safeNumber(ar.recentTradesMaxTotalPnlPercent, -20),
            stopLossBurstCount: safeNumber(ar.stopLossBurstCount, 3),
            stopLossBurstWindowMinutes: safeNumber(ar.stopLossBurstWindowMinutes, 10)
        };
    }

    getTodayTrades() {
        const today = new Date().toISOString().slice(0, 10);
        return storage.getTrades().filter(trade => String(trade.closedAt || '').startsWith(today));
    }

    getDailyPnlStats() {
        const trades = this.getTodayTrades();
        const netPnlSol = trades.reduce((sum, trade) => sum + safeNumber(trade.netPnlSol, 0), 0);
        const startBalance = safeNumber(storage.getPortfolio().startBalance, safeNumber(config.trading.paperBalance, 1));
        const pnlPercent = startBalance > 0 ? (netPnlSol / startBalance) * 100 : 0;
        return { trades, netPnlSol, pnlPercent };
    }

    checkDailyLossLimit() {
        const dailyRisk = this.getDailyRiskConfig();
        if (!dailyRisk.enabled) return { hit: false };
        const daily = this.getDailyPnlStats();
        const lossSol = Math.max(0, -daily.netPnlSol);
        const lossPercent = Math.max(0, -daily.pnlPercent);
        const hitSol = dailyRisk.maxDailyLossSol > 0 && lossSol >= dailyRisk.maxDailyLossSol;
        const hitPercent = dailyRisk.maxDailyLossPercent > 0 && lossPercent >= dailyRisk.maxDailyLossPercent;
        if (!hitSol && !hitPercent) return { hit: false, ...daily };
        return {
            hit: true,
            reason: hitSol ? `Daily loss ${lossSol.toFixed(6)} SOL >= ${dailyRisk.maxDailyLossSol} SOL` : `Daily loss ${lossPercent.toFixed(2)}% >= ${dailyRisk.maxDailyLossPercent}%`,
            lossSol,
            lossPercent,
            ...daily
        };
    }

    calculateAdaptivePositionSize(token) {
        const ps = this.getPositionSizingConfig();
        if (!ps.enabled) return { size: safeNumber(config.trading.positionSize, 0.2), multiplier: 1, reasons: ['fixed_size'] };
        let multiplier = 1;
        const reasons = [];
        const liquidityUsd = safeNumber(token.liquidity?.usd || token.liquidityUsd, 0);
        const volatility = safeNumber(token.volatility, 0);
        const portfolio = storage.getPortfolio();
        const peakBalance = safeNumber(portfolio.peakBalance, portfolio.currentBalance);
        const currentBalance = safeNumber(portfolio.currentBalance, portfolio.startBalance);
        const drawdown = peakBalance > 0 ? ((peakBalance - currentBalance) / peakBalance) * 100 : 0;
        const consecutiveLosses = safeNumber(storage.getState().consecutiveLosses, 0);
        const tokenScore = this.getTokenHistoryScore(token.baseToken?.address).score;
        if (token.flatObservation) { multiplier *= ps.flatObservationMultiplier; reasons.push(`flat:${ps.flatObservationMultiplier}`); }
        if (liquidityUsd > 0 && liquidityUsd < ps.lowLiquidityThresholdUsd) { multiplier *= ps.lowLiquidityMultiplier; reasons.push(`low_liq:${ps.lowLiquidityMultiplier}`); }
        if (volatility >= ps.highVolatilityThreshold) { multiplier *= ps.highVolatilityMultiplier; reasons.push(`high_vol:${ps.highVolatilityMultiplier}`); }
        if (drawdown >= ps.drawdownThresholdPercent) { multiplier *= ps.drawdownMultiplier; reasons.push(`drawdown:${ps.drawdownMultiplier}`); }
        if (consecutiveLosses >= ps.losingStreakCount) { multiplier *= ps.losingStreakMultiplier; reasons.push(`loss_streak:${ps.losingStreakMultiplier}`); }
        if (tokenScore < ps.badTokenScoreThreshold) { multiplier *= ps.tokenScorePenaltyMultiplier; reasons.push(`token_score:${ps.tokenScorePenaltyMultiplier}`); }
        const size = clampNumber(ps.baseSizeSol * multiplier, ps.minSizeSol, ps.maxSizeSol, ps.baseSizeSol);
        return { size, multiplier, reasons: reasons.length ? reasons : ['normal'] };
    }

    isFlatObservation(uniquePrices) {
        const flat = this.getAdaptiveRiskConfig().flatObservation;
        return flat.enabled !== false && uniquePrices <= safeNumber(flat.maxUniquePrices, 1);
    }

    calculateDynamicSlippage(side, marketContext = {}) {
        const exec = this.getPaperExecutionConfig();
        const isBuy = side === 'buy';
        const base = isBuy ? exec.baseBuySlippageBps : exec.baseSellSlippageBps;
        const fallback = isBuy ? exec.buySlippageBps : exec.sellSlippageBps;
        const min = isBuy ? exec.minBuySlippageBps : exec.minSellSlippageBps;
        const max = isBuy ? exec.maxBuySlippageBps : exec.maxSellSlippageBps;
        if (!exec.dynamicSlippage) {
            const fixed = fallback || base;
            return { slippageBps: clampNumber(fixed, min, max, fixed), breakdown: { mode: 'fixed', baseBps: fixed } };
        }
        const volatility = Math.max(0, safeNumber(marketContext.volatility, 0));
        const priceRange = Math.max(0, safeNumber(marketContext.priceRange, 0));
        const liquidityUsd = Math.max(0, safeNumber(marketContext.liquidityUsd, 0));
        const positionSizeSol = Math.max(0, safeNumber(marketContext.positionSizeSol, config.trading.positionSize));
        const failedSellAttempts = Math.max(0, safeNumber(marketContext.failedSellAttempts, 0));
        const flatPenaltyBps = marketContext.flatObservation ? 40 : 0;
        const volatilityBps = volatility * exec.volatilitySlippageMultiplier;
        const priceRangeBps = priceRange * exec.priceRangeSlippageMultiplier;
        const liquidityBps = liquidityUsd > 0 && liquidityUsd < exec.lowLiquidityThresholdUsd ? (1 - liquidityUsd / exec.lowLiquidityThresholdUsd) * exec.lowLiquiditySlippageBps : 0;
        const positionUsd = positionSizeSol * this.getPriceMonitoringConfig().assumedSolUsd;
        const sizeImpactBps = liquidityUsd > 0 ? (positionUsd / liquidityUsd) * exec.sizeImpactMultiplier * 100 : exec.sizeImpactMultiplier;
        const jitterBps = Math.random() * Math.max(0, exec.randomJitterBps);
        const retryPenaltyBps = isBuy ? 0 : failedSellAttempts * exec.sellRetryPenaltyBps;
        const sellPenaltyMultiplier = isBuy ? 1 : 1.25;
        const raw = base + (volatilityBps * sellPenaltyMultiplier) + (priceRangeBps * sellPenaltyMultiplier) + liquidityBps + sizeImpactBps + jitterBps + retryPenaltyBps + flatPenaltyBps;
        return { slippageBps: clampNumber(raw, min, max, base), breakdown: { mode: 'dynamic', baseBps: base, volatilityBps, priceRangeBps, liquidityBps, sizeImpactBps, jitterBps, retryPenaltyBps, flatPenaltyBps, liquidityUsd, positionSizeSol, failedSellAttempts } };
    }

    calculateDynamicFailureChance(side, slippageBps) {
        const exec = this.getPaperExecutionConfig();
        const base = side === 'buy' ? exec.baseBuyFailureChance : exec.baseSellFailureChance;
        const max = side === 'buy' ? exec.maxBuyFailureChance : exec.maxSellFailureChance;
        const extra = (Math.max(0, slippageBps) / 100) * exec.failureChancePer100BpsSlippage;
        return Math.min(clampProbability(base + extra, base), max);
    }

    simulateBuyExecution(quotedPrice, positionSizeSol, token = {}) {
        const exec = this.getPaperExecutionConfig();
        const assumedSolUsd = this.getPriceMonitoringConfig().assumedSolUsd;
        if (!exec.enabled) return { ok: true, quotedPrice, executionPrice: quotedPrice, feeSol: 0, slippageBps: 0, slippageBreakdown: null, failureChance: 0, dexFeeBps: 0, receivedTokenUnits: (positionSizeSol * assumedSolUsd) / quotedPrice, spentSol: positionSizeSol, failureReason: null };
        const slippage = this.calculateDynamicSlippage('buy', { volatility: token.volatility, priceRange: token.priceRange, liquidityUsd: safeNumber(token.liquidity?.usd || token.liquidityUsd, 0), positionSizeSol, flatObservation: token.flatObservation });
        const failureChance = this.calculateDynamicFailureChance('buy', slippage.slippageBps);
        if (Math.random() < failureChance) return { ok: false, quotedPrice, executionPrice: null, feeSol: exec.networkFeeSol, slippageBps: slippage.slippageBps, slippageBreakdown: slippage.breakdown, failureChance, dexFeeBps: exec.dexFeeBps, receivedTokenUnits: 0, spentSol: exec.networkFeeSol, failureReason: 'Simulated BUY failed: RPC timeout / route changed / blockhash expired' };
        const feeSol = exec.networkFeeSol + exec.priorityFeeSol;
        const executionPrice = quotedPrice * (1 + bpsToMultiplier(slippage.slippageBps + exec.dexFeeBps));
        const receivedTokenUnits = executionPrice > 0 ? (Math.max(positionSizeSol - feeSol, 0) * assumedSolUsd) / executionPrice : 0;
        return { ok: true, quotedPrice, executionPrice, feeSol, slippageBps: slippage.slippageBps, slippageBreakdown: slippage.breakdown, failureChance, dexFeeBps: exec.dexFeeBps, receivedTokenUnits, spentSol: positionSizeSol, failureReason: null };
    }

    simulateSellExecution(quotedPrice, position, reason) {
        const exec = this.getPaperExecutionConfig();
        const assumedSolUsd = this.getPriceMonitoringConfig().assumedSolUsd;
        const failedSellAttempts = safeNumber(position.failedSellAttempts, 0);
        if (!exec.enabled) {
            const grossReturnSol = position.positionSize * (quotedPrice / position.entryPrice);
            const netPnlSol = grossReturnSol - position.positionSize;
            return { ok: true, quotedPrice, executionPrice: quotedPrice, feeSol: 0, slippageBps: 0, slippageBreakdown: null, failureChance: 0, dexFeeBps: 0, grossReturnSol, netReturnSol: grossReturnSol, netPnlSol, netPnlPercent: (netPnlSol / position.positionSize) * 100, failureReason: null, reason };
        }
        const slippage = this.calculateDynamicSlippage('sell', { volatility: position.volatility, priceRange: position.priceRange, liquidityUsd: position.liquidityUsd, positionSizeSol: position.positionSize, failedSellAttempts, flatObservation: position.flatObservation });
        const failureChance = this.calculateDynamicFailureChance('sell', slippage.slippageBps);
        if (Math.random() < failureChance && failedSellAttempts < exec.maxSellFailureRetries) return { ok: false, quotedPrice, executionPrice: null, feeSol: exec.networkFeeSol, slippageBps: slippage.slippageBps, slippageBreakdown: slippage.breakdown, failureChance, dexFeeBps: exec.dexFeeBps, grossReturnSol: 0, netReturnSol: -exec.networkFeeSol, netPnlSol: null, netPnlPercent: null, failureReason: 'Simulated SELL failed: slippage exceeded / transaction not landed', reason };
        const feeSol = exec.networkFeeSol + exec.priorityFeeSol;
        const executionPrice = Math.max(quotedPrice * (1 - bpsToMultiplier(slippage.slippageBps + exec.dexFeeBps)), 0);
        const tokenUnits = safeNumber(position.receivedTokenUnits, 0);
        const grossReturnSol = tokenUnits > 0 ? (tokenUnits * executionPrice) / assumedSolUsd : position.positionSize * (executionPrice / position.entryPrice);
        const netReturnSol = Math.max(grossReturnSol - feeSol, 0);
        const netPnlSol = netReturnSol - position.positionSize;
        return { ok: true, quotedPrice, executionPrice, feeSol, slippageBps: slippage.slippageBps, slippageBreakdown: slippage.breakdown, failureChance, dexFeeBps: exec.dexFeeBps, grossReturnSol, netReturnSol, netPnlSol, netPnlPercent: (netPnlSol / position.positionSize) * 100, failureReason: null, reason };
    }

    recoverOpenPosition() { if (!this.hasRecovered && storage.loadActivePosition()) { this.currentPosition = storage.loadActivePosition(); this.startMonitoring(); this.hasRecovered = true; } }

    async validateTokenOnChain(tokenAddress) {
        try { return !!(await this.connection.getAccountInfo(new PublicKey(tokenAddress))); }
        catch (error) { activityLogger.log('RPC_WARNING', { message: 'Token validation failed', tokenAddress, error: error.message }); return false; }
    }

    getJupiterHeaders() { const headers = { Accept: 'application/json' }; if (process.env.JUPITER_API_KEY) headers['x-api-key'] = process.env.JUPITER_API_KEY; return headers; }

    async getTokenDecimals(mint) {
        if (mint === SOL_MINT) return SOL_DECIMALS;
        if (this.decimalsCache.has(mint)) return this.decimalsCache.get(mint);
        try { const account = await this.connection.getParsedAccountInfo(new PublicKey(mint)); const decimals = safeNumber(account.value?.data?.parsed?.info?.decimals, 6); this.decimalsCache.set(mint, decimals); return decimals; }
        catch (error) { activityLogger.log('TOKEN_DECIMALS_ERROR', { mint, error: error.message }); return 6; }
    }

    async getJupiterSellPrice(position, timeoutMs = null) {
        try {
            const pm = this.getPriceMonitoringConfig();
            const tokenUnits = safeNumber(position?.receivedTokenUnits, 0);
            if (!position?.address || tokenUnits <= 0) return null;
            const decimals = await this.getTokenDecimals(position.address);
            const amount = Math.floor(tokenUnits * Math.pow(10, decimals));
            if (!Number.isFinite(amount) || amount <= 0) return null;
            const response = await axios.get(pm.jupiterQuoteUrl, { params: { inputMint: position.address, outputMint: SOL_MINT, amount: String(amount), slippageBps: String(pm.jupiterSlippageBps), onlyDirectRoutes: String(pm.jupiterOnlyDirectRoutes) }, headers: this.getJupiterHeaders(), timeout: timeoutMs || pm.timeoutMs });
            const outSol = safeNumber(response.data?.outAmount, 0) / Math.pow(10, SOL_DECIMALS);
            const tokenPriceUsd = (outSol / tokenUnits) * pm.assumedSolUsd;
            if (!Number.isFinite(tokenPriceUsd) || tokenPriceUsd <= 0) return null;
            position.lastJupiterQuoteAt = new Date().toISOString();
            position.lastJupiterOutSol = outSol;
            position.lastJupiterPriceUsd = tokenPriceUsd;
            position.lastJupiterPriceImpactPct = response.data?.priceImpactPct;
            return tokenPriceUsd;
        } catch (error) { activityLogger.log('JUPITER_QUOTE_ERROR', { symbol: position?.symbol, address: position?.address, error: error.response?.data?.error || error.message }); return null; }
    }

    async getDexScreenerPrice(pairAddress, validateOnChain = false, timeoutMs = null) {
        try {
            const pm = this.getPriceMonitoringConfig();
            const resp = await axios.get(`${this.pairEndpoint}${pairAddress}`, { timeout: timeoutMs || pm.timeoutMs });
            const price = parseFloat(resp.data?.pair?.priceUsd);
            if (!Number.isFinite(price) || price <= 0) return null;
            if (!validateOnChain) return price;
            return (await this.validateTokenOnChain(resp.data.pair.baseToken.address)) ? price : null;
        } catch (error) { if (error.response?.status === 429) activityLogger.log('RATE_LIMIT', { message: 'DexScreener API returned 429' }); return null; }
    }

    async getActivePositionPrice(timeoutMs = null) {
        const pm = this.getPriceMonitoringConfig();
        if (pm.source === 'jupiter') {
            const jupiterPrice = await this.getJupiterSellPrice(this.currentPosition, timeoutMs);
            if (jupiterPrice) return { price: jupiterPrice, source: 'jupiter' };
            if (!pm.fallbackToDexScreener) return { price: null, source: 'jupiter_miss' };
        }
        const dexPrice = await this.getDexScreenerPrice(this.currentPosition.pairAddress, false, timeoutMs);
        return { price: dexPrice, source: dexPrice ? 'dexscreener' : 'dex_miss' };
    }

    async checkWalletMonopoly(tokenAddress) {
        try {
            const response = await axios.post(this.alchemyRpcUrl, { jsonrpc: '2.0', id: 1, method: 'getTokenLargestAccounts', params: [tokenAddress] }, { headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
            const largestAccounts = response.data?.result?.value;
            if (!largestAccounts) return false;
            const topHolders = largestAccounts.slice(0, 10);
            let totalSupply = 0, topHolderAmount = 0;
            topHolders.forEach((account, index) => { const amount = parseFloat(account.amount); totalSupply += amount; if (index === 0) topHolderAmount = amount; });
            return totalSupply > 0 && (topHolderAmount / totalSupply) * 100 > 70;
        } catch (error) { activityLogger.log('MONOPOLY_CHECK_ERROR', { token: tokenAddress, error: error.message }); return false; }
    }

    async checkWashTrading(tokenAddress, pairAddress) {
        try {
            const response = await axios.get(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}`, { headers: { Accept: 'application/json' }, timeout: 8000 });
            const a = response.data?.data?.attributes;
            if (!a) return false;
            const tx = a.txns?.m5?.buys || a.transactions_5m || 0;
            const vol = parseFloat(a.volume_usd || 0) || 0;
            const buyers = a.unique_buyers_m5 || a.unique_traders_m5 || 0;
            return (vol / Math.max(tx, 1) < 2 && tx > 5) || (buyers > 0 && tx / buyers > 20 && tx > 10) || (buyers / Math.max(tx, 1) < 0.1 && tx > 10);
        } catch (error) { activityLogger.log('WASH_TRADING_CHECK_ERROR', { token: tokenAddress, error: error.message }); return false; }
    }

    getTokenHistoryScore(tokenAddress) {
        const trades = storage.getTradesByAddress(tokenAddress);
        let score = 0;
        trades.forEach(trade => { const pnl = safeNumber(trade.pnl, 0); const reason = String(trade.reason || ''); if (pnl > 0) score += 1; if (reason.includes('Moon Target')) score += 2; if (pnl < 0) score -= 1; if (reason.includes('Stop Loss')) score -= 2; if (reason.includes('Time Limit') && pnl < 0) score -= 1; });
        const lastThree = trades.slice(-3);
        return { score, tradeCount: trades.length, lastNNegative: lastThree.length >= 3 && lastThree.every(trade => safeNumber(trade.pnl, 0) < 0) };
    }

    shouldSkipTokenByHistory(token) {
        const ar = this.getAdaptiveRiskConfig();
        const state = storage.getState();
        const address = token.baseToken?.address;
        const tokenState = state.tokenStats?.[address];
        if (!address || !tokenState) return { skip: false };
        if (tokenState.blacklisted) return { skip: true, reason: 'Token sudah blacklisted di botState.' };
        if (tokenState.cooldownUntil && Date.now() < tokenState.cooldownUntil) return { skip: true, reason: 'Token masih cooldown.' };
        if (safeNumber(tokenState.slCount, 0) >= ar.sessionBlacklistStopLossCount) return { skip: true, reason: `Token mencapai ${ar.sessionBlacklistStopLossCount} stop loss dalam sesi ini.` };
        const history = this.getTokenHistoryScore(address);
        if (history.lastNNegative) return { skip: true, reason: 'Tiga trade terakhir token ini negatif.' };
        if (history.score < ar.minTokenScore) return { skip: true, reason: `Token score terlalu rendah (${history.score}).` };
        return { skip: false };
    }

    async observeAndConfirm(token) {
        const obs = config.observation;
        const ar = this.getAdaptiveRiskConfig();
        const pm = this.getPriceMonitoringConfig();
        activityLogger.log('OBSERVATION_START', { symbol: token.baseToken.symbol });
        console.log(chalk.cyan(`\n[Observer] 🕵️ Menunda Entry. Mengawasi ${token.baseToken.symbol} selama ${obs.durationSeconds} detik...`));
        if (pm.validateOnChainOnce && !(await this.validateTokenOnChain(token.baseToken.address))) return false;
        const prices = [];
        const startedAt = Date.now();
        const durationMs = safeNumber(obs.durationSeconds, 10) * 1000;
        while (Date.now() - startedAt < durationMs) { const price = await this.getDexScreenerPrice(token.pairAddress, false, pm.timeoutMs); if (price) prices.push(price); await sleep(pm.observationIntervalMs); }
        if (prices.length < 3) return false;
        const uniquePrices = new Set(prices.map(price => Number(price).toPrecision(12))).size;
        if (uniquePrices < safeNumber(obs.minUniquePrices, 1)) return false;
        const flatObservation = this.isFlatObservation(uniquePrices);
        if (await this.checkWalletMonopoly(token.baseToken.address)) return false;
        if (await this.checkWashTrading(token.baseToken.address, token.pairAddress)) return false;
        const startPrice = prices[0], endPrice = prices[prices.length - 1], minPrice = Math.min(...prices), maxPrice = Math.max(...prices);
        if (((endPrice - startPrice) / startPrice) * 100 < -3) return false;
        const maxDropPercent = ((maxPrice - minPrice) / maxPrice) * 100;
        if (maxDropPercent > safeNumber(obs.maxDumpPercent, 22)) return false;
        if (((maxPrice - endPrice) / maxPrice) * 100 > safeNumber(obs.maxFromPeakPercent, 10)) return false;
        const priceChanges = [];
        for (let i = 1; i < prices.length; i++) priceChanges.push(((prices[i] - prices[i - 1]) / prices[i - 1]) * 100);
        const mean = priceChanges.reduce((a, b) => a + b, 0) / priceChanges.length;
        const volatility = Math.sqrt(priceChanges.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / priceChanges.length);
        if (!flatObservation && volatility > ar.maxAllowedVolatility) return false;
        Object.assign(token, { volatility, priceRange: maxDropPercent, confirmedEntryPrice: endPrice, observedStartPrice: startPrice, observedMaxPrice: maxPrice, observedMinPrice: minPrice, uniquePrices, flatObservation });
        console.log(chalk.green.bold('\n[Observer] ✅ TERKONFIRMASI! Trend positif terdeteksi. Mengeksekusi BUY!'));
        return true;
    }

    getPositionRiskProfile(token, volatility) {
        const flat = this.getAdaptiveRiskConfig().flatObservation || {};
        if (token.flatObservation && flat.enabled !== false) return { trailingStopPercent: safeNumber(flat.trailingStopPercent, 3), targetProfitPercent: safeNumber(flat.targetProfitPercent, 5), stopLossPercent: safeNumber(flat.stopLossPercent, 7), trailingStartPercent: safeNumber(flat.trailingStartPercent, 7), timeLimitMinutes: safeNumber(flat.timeLimitMinutes, 10) };
        return { trailingStopPercent: volatility > 1 ? 8 : volatility >= 0.5 ? 5 : 2, targetProfitPercent: volatility > 1 ? 15 : volatility >= 0.5 ? 10 : 7, stopLossPercent: config.trading.stopLossPercent, trailingStartPercent: config.trading.trailingStartPercent, timeLimitMinutes: config.trading.timeLimitMinutes };
    }

    async openPosition(token) {
        if (this.currentPosition) return;
        const dailyLoss = this.checkDailyLossLimit();
        if (dailyLoss.hit) {
            const state = storage.getState();
            const minutes = this.getDailyRiskConfig().pauseMinutesAfterDailyLoss;
            state.globalPauseUntil = Date.now() + minutes * 60 * 1000;
            storage.saveState(state);
            console.log(chalk.red(`[DAILY RISK] Entry ditolak: ${dailyLoss.reason}`));
            await telegram.sendMessage(`🛑 *DAILY LOSS LIMIT*\n${dailyLoss.reason}\nBot pause ${minutes} menit.`);
            return;
        }
        const historyGuard = this.shouldSkipTokenByHistory(token);
        if (historyGuard.skip) { console.log(chalk.yellow(`[ENTRY SKIPPED] ${token.baseToken.symbol}: ${historyGuard.reason}`)); return; }
        const quotedPrice = Number(token.confirmedEntryPrice);
        if (!Number.isFinite(quotedPrice) || quotedPrice <= 0) return;
        const sizing = this.calculateAdaptivePositionSize(token);
        const positionSize = sizing.size;
        const buyExecution = this.simulateBuyExecution(quotedPrice, positionSize, token);
        if (!buyExecution.ok) return;
        const riskProfile = this.getPositionRiskProfile(token, token.volatility || 0);
        this.currentPosition = { symbol: token.baseToken.symbol, address: token.baseToken.address, pairAddress: token.pairAddress, quotedEntryPrice: quotedPrice, entryPrice: buyExecution.executionPrice, maxPrice: buyExecution.executionPrice, positionSize, positionSizing: sizing, openedAt: new Date().toISOString(), receivedTokenUnits: buyExecution.receivedTokenUnits, buyFeeSol: buyExecution.feeSol, buySlippageBps: buyExecution.slippageBps, buySlippageBreakdown: buyExecution.slippageBreakdown, buyFailureChance: buyExecution.failureChance, dexFeeBps: buyExecution.dexFeeBps, failedSellAttempts: 0, liquidityUsd: Number(token.liquidity?.usd || 0), priceRange: token.priceRange, observedStartPrice: token.observedStartPrice, observedMaxPrice: token.observedMaxPrice, observedMinPrice: token.observedMinPrice, uniquePrices: token.uniquePrices, flatObservation: token.flatObservation, dynamicTrailingStopPercent: riskProfile.trailingStopPercent, dynamicTargetProfitPercent: riskProfile.targetProfitPercent, dynamicStopLossPercent: riskProfile.stopLossPercent, dynamicTrailingStartPercent: riskProfile.trailingStartPercent, dynamicTimeLimitMinutes: riskProfile.timeLimitMinutes, volatility: token.volatility || 0 };
        storage.saveActivePosition(this.currentPosition);
        console.log(chalk.green.bold(`\n[BUY] Mengunci target: ${this.currentPosition.symbol}`));
        console.log(chalk.gray(`[Sizing] ${positionSize.toFixed(4)} SOL | multiplier ${sizing.multiplier.toFixed(3)} | ${sizing.reasons.join(', ')}`));
        await telegram.notifyTrade('BUY', { symbol: this.currentPosition.symbol, price: this.currentPosition.entryPrice, quotedPrice, address: this.currentPosition.address, feeSol: buyExecution.feeSol, slippageBps: buyExecution.slippageBps });
        this.startMonitoring();
    }

    startMonitoring() { if (this.isPolling) return; this.isPolling = true; this.pollPositionLoop(); }

    async pollPositionLoop() { const pm = this.getPriceMonitoringConfig(); while (this.isPolling && this.currentPosition) { const startedAt = Date.now(); try { await this.checkPositionOnce(pm); } catch (e) { console.error(chalk.red('\nError Monitoring:'), e.message); } await sleep(Math.max(pm.minDelayMs, pm.activeIntervalMs - (Date.now() - startedAt))); } this.isPolling = false; }

    async checkPositionOnce(pm = this.getPriceMonitoringConfig()) {
        if (!this.currentPosition) return;
        const quote = await this.getActivePositionPrice(pm.timeoutMs);
        if (!quote.price) { process.stdout.write(chalk.gray(`\rMonitoring ${this.currentPosition.symbol}: price tick missed (${quote.source})    `)); return; }
        const currentPrice = quote.price;
        const pnl = ((currentPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice) * 100;
        if (currentPrice > this.currentPosition.maxPrice) { this.currentPosition.maxPrice = currentPrice; this.currentPosition.maxPriceUpdatedAt = new Date().toISOString(); storage.saveActivePosition(this.currentPosition); }
        const maxPnl = ((this.currentPosition.maxPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice) * 100;
        process.stdout.write(chalk.white(`\rMonitoring ${this.currentPosition.symbol}: PNL ${pnl.toFixed(2)}% | Max ${maxPnl.toFixed(2)}% | Size ${this.currentPosition.positionSize.toFixed(3)} | Src ${quote.source}    `));
        this.checkExitConditions(currentPrice, pnl, maxPnl);
    }

    stopMonitoring() { this.isPolling = false; if (this.checkInterval) clearInterval(this.checkInterval); this.checkInterval = null; }

    getElapsedSeconds() { return this.currentPosition?.openedAt ? (Date.now() - new Date(this.currentPosition.openedAt).getTime()) / 1000 : 0; }

    checkAdaptiveExit(currentPrice, pnl, maxPnl) {
        const ar = this.getAdaptiveRiskConfig();
        const elapsedMinutes = this.getElapsedSeconds() / 60;
        for (const tier of [...ar.profitLockTiers].sort((a, b) => safeNumber(b.maxPnl) - safeNumber(a.maxPnl))) if (maxPnl >= safeNumber(tier.maxPnl) && pnl < safeNumber(tier.lockPnl)) return `🔒 Tiered Profit Lock: Max ${maxPnl.toFixed(2)}%, turun di bawah ${tier.lockPnl}%`;
        for (const rule of ar.stagnationRules) if (elapsedMinutes >= safeNumber(rule.minutes) && rule.minMaxPnl !== undefined && maxPnl < safeNumber(rule.minMaxPnl)) return `⌛ Stagnation Exit: ${elapsedMinutes.toFixed(1)}m Max PNL < ${rule.minMaxPnl}%`;
        return null;
    }

    checkExitConditions(currentPrice, pnl, maxPnl) {
        const targetProfitPercent = this.currentPosition.dynamicTargetProfitPercent || config.trading.targetProfitPercent;
        const trailingStopPercent = this.currentPosition.dynamicTrailingStopPercent || config.trading.trailingStopPercent;
        const trailingStartPercent = this.currentPosition.dynamicTrailingStartPercent || config.trading.trailingStartPercent;
        const stopLossPercent = this.currentPosition.dynamicStopLossPercent || config.trading.stopLossPercent;
        const timeLimitMinutes = this.currentPosition.dynamicTimeLimitMinutes || config.trading.timeLimitMinutes;
        if (pnl >= targetProfitPercent) return this.closePosition(currentPrice, pnl, `🚀 Moon Target Reached (${targetProfitPercent}%)`);
        const adaptiveReason = this.checkAdaptiveExit(currentPrice, pnl, maxPnl);
        if (adaptiveReason) return this.closePosition(currentPrice, pnl, adaptiveReason);
        if (pnl >= trailingStartPercent) { const trailThreshold = this.currentPosition.maxPrice * (1 - trailingStopPercent / 100); if (currentPrice <= trailThreshold) return this.closePosition(currentPrice, pnl, `🛡️ Trailing Stop: Locked at ${pnl.toFixed(2)}% (Dynamic ${trailingStopPercent}%)`); }
        if (pnl <= -stopLossPercent) return this.closePosition(currentPrice, pnl, `❌ Stop Loss Terkena (${stopLossPercent}%)`);
        if (this.getElapsedSeconds() / 60 >= timeLimitMinutes) return this.closePosition(currentPrice, pnl, `⌛ Time Limit: ${timeLimitMinutes}m`);
    }

    updateGlobalPauseFromRecentPerformance(state) {
        const ar = this.getAdaptiveRiskConfig();
        const cRisk = config.riskManagement;
        const portfolio = storage.getPortfolio();
        const now = Date.now();
        const dailyLoss = this.checkDailyLossLimit();
        if (dailyLoss.hit) { const minutes = this.getDailyRiskConfig().pauseMinutesAfterDailyLoss; state.globalPauseUntil = Math.max(state.globalPauseUntil || 0, now + minutes * 60 * 1000); return dailyLoss.reason; }
        if (portfolio.peakBalance > 0) { const drawdown = ((portfolio.peakBalance - portfolio.currentBalance) / portfolio.peakBalance) * 100; if (drawdown >= ar.maxPortfolioDrawdownPercent) { state.globalPauseUntil = Math.max(state.globalPauseUntil || 0, now + cRisk.globalPauseMinutes * 60 * 1000); return `Portfolio drawdown ${drawdown.toFixed(2)}% >= ${ar.maxPortfolioDrawdownPercent}%`; } }
        const recentTrades = storage.getRecentTrades(ar.recentTradeCount);
        if (recentTrades.length >= ar.recentTradeCount) { const recentTotalPnl = recentTrades.reduce((sum, trade) => sum + safeNumber(trade.pnl), 0); if (recentTotalPnl <= ar.recentTradesMaxTotalPnlPercent) { state.globalPauseUntil = Math.max(state.globalPauseUntil || 0, now + cRisk.globalPauseMinutes * 60 * 1000); return `${ar.recentTradeCount} trade terakhir total PNL ${recentTotalPnl.toFixed(2)}%`; } }
        const stopLossBurst = storage.getTrades().filter(trade => now - new Date(trade.closedAt || 0).getTime() <= ar.stopLossBurstWindowMinutes * 60 * 1000 && String(trade.reason || '').includes('Stop Loss'));
        if (stopLossBurst.length >= ar.stopLossBurstCount) { state.globalPauseUntil = Math.max(state.globalPauseUntil || 0, now + cRisk.globalPauseMinutes * 60 * 1000); return `${stopLossBurst.length} stop loss dalam ${ar.stopLossBurstWindowMinutes} menit`; }
        return null;
    }

    async closePosition(price, pnl, reason) {
        this.stopMonitoring();
        const cRisk = config.riskManagement;
        const ar = this.getAdaptiveRiskConfig();
        const tokenAddress = this.currentPosition.address;
        const sellExecution = this.simulateSellExecution(price, this.currentPosition, reason);
        if (!sellExecution.ok) { this.currentPosition.failedSellAttempts = safeNumber(this.currentPosition.failedSellAttempts) + 1; this.currentPosition.lastSellFailureAt = new Date().toISOString(); this.currentPosition.lastSellFailureReason = sellExecution.failureReason; this.currentPosition.accumulatedFailedSellFeesSol = safeNumber(this.currentPosition.accumulatedFailedSellFeesSol) + sellExecution.feeSol; storage.saveActivePosition(this.currentPosition); activityLogger.log('PAPER_SELL_FAILED', { symbol: this.currentPosition.symbol, address: tokenAddress, attempts: this.currentPosition.failedSellAttempts, ...sellExecution }); await telegram.sendMessage(`🟠 *PAPER SELL FAILED*\nToken: ${this.currentPosition.symbol}\nReason: ${sellExecution.failureReason}\nAttempt: ${this.currentPosition.failedSellAttempts}/${this.getPaperExecutionConfig().maxSellFailureRetries}`); this.startMonitoring(); return; }
        const accumulatedFailedSellFeesSol = safeNumber(this.currentPosition.accumulatedFailedSellFeesSol);
        sellExecution.netPnlSol -= accumulatedFailedSellFeesSol;
        sellExecution.netPnlPercent = (sellExecution.netPnlSol / this.currentPosition.positionSize) * 100;
        const tradeData = { ...this.currentPosition, quotedExitPrice: price, exitPrice: sellExecution.executionPrice, pnl: sellExecution.netPnlPercent, grossMarketPnlPercent: pnl, netPnlSol: sellExecution.netPnlSol, grossReturnSol: sellExecution.grossReturnSol, netReturnSol: sellExecution.netReturnSol, sellFeeSol: sellExecution.feeSol, totalFeeSol: safeNumber(this.currentPosition.buyFeeSol) + sellExecution.feeSol + accumulatedFailedSellFeesSol, accumulatedFailedSellFeesSol, sellSlippageBps: sellExecution.slippageBps, sellSlippageBreakdown: sellExecution.slippageBreakdown, sellFailureChance: sellExecution.failureChance, reason, closedAt: new Date().toISOString() };
        try {
            storage.saveTrade(tradeData);
            const state = storage.getState();
            if (!state.tokenStats[tokenAddress]) state.tokenStats[tokenAddress] = { slCount: 0, cooldownUntil: 0, blacklisted: false };
            const tState = state.tokenStats[tokenAddress];
            let alertMsg = '';
            if (tradeData.netPnlSol < 0) { state.consecutiveLosses += 1; tState.slCount += 1; if (tradeData.pnl <= cRisk.rugpullThresholdPercent) { tState.blacklisted = true; alertMsg = `🚨 *RUGPULL DETECTED* (${tradeData.pnl.toFixed(2)}%).`; } else if (tState.slCount >= ar.sessionBlacklistStopLossCount) { tState.blacklisted = true; alertMsg = `🚫 *SESSION BLACKLIST*. Token kena SL ${tState.slCount}x.`; } else if (tState.slCount >= ar.maxStopLossCountBeforeCooldown) { tState.cooldownUntil = Date.now() + ar.extendedCooldownHours * 60 * 60 * 1000; alertMsg = `⏸️ *Extended Cooldown*. Token kena SL ${tState.slCount}x.`; } else if (tState.slCount >= 2) { tState.cooldownUntil = Date.now() + cRisk.slCooldown2xMinutes * 60 * 1000; alertMsg = `⏸️ *Kena SL 2x*. Cooldown token ${cRisk.slCooldown2xMinutes} menit.`; } else { tState.cooldownUntil = Date.now() + cRisk.slCooldown1xMinutes * 60 * 1000; alertMsg = `⏳ *Kena SL 1x*. Token cooldown ${cRisk.slCooldown1xMinutes} menit.`; } if (state.consecutiveLosses >= cRisk.maxConsecutiveLosses) { state.globalPauseUntil = Date.now() + cRisk.globalPauseMinutes * 60 * 1000; state.consecutiveLosses = 0; } } else { state.consecutiveLosses = 0; tState.cooldownUntil = Date.now() + 5 * 60 * 1000; }
            state.tokenStats[tokenAddress] = tState;
            const pauseReason = this.updateGlobalPauseFromRecentPerformance(state);
            storage.saveState(state);
            await telegram.notifyTrade('SELL', tradeData);
            if (alertMsg) await telegram.sendMessage(alertMsg);
            if (pauseReason) await telegram.sendMessage(`🛑 *GLOBAL PAUSE DIAKTIFKAN*\n${pauseReason}`);
        } catch (error) { console.error('Gagal menutup posisi:', error.message); }
        finally { this.currentPosition = null; this.hasRecovered = false; }
    }
}

module.exports = new EngineService();