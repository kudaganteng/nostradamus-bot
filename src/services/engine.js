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

function getAlchemyRpcUrl() {
    const url = process.env.ALCHEMY_RPC_URL;
    if (!url || !url.trim()) throw new Error('ALCHEMY_RPC_URL belum diisi. Tambahkan ALCHEMY_RPC_URL ke file .env.');
    return url.trim();
}

function safeNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clampProbability(value, fallback = 0) {
    const n = safeNumber(value, fallback);
    return Math.min(Math.max(n, 0), 1);
}

function clampNumber(value, min, max, fallback = min) {
    const n = safeNumber(value, fallback);
    return Math.min(Math.max(n, min), max);
}

function bpsToMultiplier(bps) {
    return safeNumber(bps, 0) / 10000;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class EngineService {
    constructor() {
        storage.init();
        this.alchemyRpcUrl = getAlchemyRpcUrl();
        this.connection = new Connection(this.alchemyRpcUrl, 'confirmed');
        this.checkInterval = null;
        this.isPolling = false;
        this.pairEndpoint = 'https://api.dexscreener.com/latest/dex/pairs/solana/';
        this.decimalsCache = new Map();
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
            timeoutMs: Math.max(300, safeNumber(pm.timeoutMs, 800)),
            minDelayMs: Math.max(50, safeNumber(pm.minDelayMs, 150)),
            validateOnChainOnce: pm.validateOnChainOnce !== false,
            fallbackToDexScreener: pm.fallbackToDexScreener !== false,
            jupiterQuoteUrl: pm.jupiterQuoteUrl || 'https://quote-api.jup.ag/v6/quote',
            jupiterSlippageBps: Math.max(1, safeNumber(pm.jupiterSlippageBps, 100)),
            jupiterOnlyDirectRoutes: pm.jupiterOnlyDirectRoutes === true,
            assumedSolUsd: Math.max(1, safeNumber(pm.assumedSolUsd, 150))
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
            buyFailureChance: clampProbability(pe.buyFailureChance, 0.03),
            sellFailureChance: clampProbability(pe.sellFailureChance, 0.05),
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
            minPnlAfterSeconds: safeNumber(ar.minPnlAfterSeconds, 90),
            minPnlRequired: safeNumber(ar.minPnlRequired, 2),
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

    isFlatObservation(uniquePrices) {
        const flat = this.getAdaptiveRiskConfig().flatObservation;
        return flat.enabled !== false && uniquePrices <= safeNumber(flat.maxUniquePrices, 1);
    }

    shouldSimulateFailure(chance) {
        return Math.random() < chance;
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
        let liquidityBps = 0;
        if (liquidityUsd > 0 && liquidityUsd < exec.lowLiquidityThresholdUsd) {
            liquidityBps = (1 - liquidityUsd / exec.lowLiquidityThresholdUsd) * exec.lowLiquiditySlippageBps;
        }
        const positionUsd = positionSizeSol * this.getPriceMonitoringConfig().assumedSolUsd;
        const sizeImpactBps = liquidityUsd > 0 ? (positionUsd / liquidityUsd) * exec.sizeImpactMultiplier * 100 : exec.sizeImpactMultiplier;
        const jitterBps = Math.random() * Math.max(0, exec.randomJitterBps);
        const retryPenaltyBps = isBuy ? 0 : failedSellAttempts * exec.sellRetryPenaltyBps;
        const sellPenaltyMultiplier = isBuy ? 1 : 1.25;
        const raw = base + (volatilityBps * sellPenaltyMultiplier) + (priceRangeBps * sellPenaltyMultiplier) + liquidityBps + sizeImpactBps + jitterBps + retryPenaltyBps + flatPenaltyBps;
        return {
            slippageBps: clampNumber(raw, min, max, base),
            breakdown: { mode: 'dynamic', baseBps: base, volatilityBps, priceRangeBps, liquidityBps, sizeImpactBps, jitterBps, retryPenaltyBps, flatPenaltyBps, liquidityUsd, positionSizeSol, failedSellAttempts }
        };
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
        if (!exec.enabled) {
            return { ok: true, quotedPrice, executionPrice: quotedPrice, feeSol: 0, slippageBps: 0, slippageBreakdown: null, failureChance: 0, dexFeeBps: 0, receivedTokenUnits: (positionSizeSol * assumedSolUsd) / quotedPrice, spentSol: positionSizeSol, failureReason: null };
        }
        const liquidityUsd = safeNumber(token.liquidity?.usd || token.liquidityUsd, 0);
        const slippage = this.calculateDynamicSlippage('buy', { volatility: token.volatility, priceRange: token.priceRange, liquidityUsd, positionSizeSol, flatObservation: token.flatObservation });
        const failureChance = exec.dynamicSlippage ? this.calculateDynamicFailureChance('buy', slippage.slippageBps) : exec.buyFailureChance;
        if (this.shouldSimulateFailure(failureChance)) return { ok: false, quotedPrice, executionPrice: null, feeSol: exec.networkFeeSol, slippageBps: slippage.slippageBps, slippageBreakdown: slippage.breakdown, failureChance, dexFeeBps: exec.dexFeeBps, receivedTokenUnits: 0, spentSol: exec.networkFeeSol, failureReason: 'Simulated BUY failed: RPC timeout / route changed / blockhash expired' };
        const feeSol = exec.networkFeeSol + exec.priorityFeeSol;
        const effectiveSpendSol = Math.max(positionSizeSol - feeSol, 0);
        const executionPrice = quotedPrice * (1 + bpsToMultiplier(slippage.slippageBps + exec.dexFeeBps));
        const receivedTokenUnits = executionPrice > 0 ? (effectiveSpendSol * assumedSolUsd) / executionPrice : 0;
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
        const failureChance = exec.dynamicSlippage ? this.calculateDynamicFailureChance('sell', slippage.slippageBps) : exec.sellFailureChance;
        if (this.shouldSimulateFailure(failureChance) && failedSellAttempts < exec.maxSellFailureRetries) return { ok: false, quotedPrice, executionPrice: null, feeSol: exec.networkFeeSol, slippageBps: slippage.slippageBps, slippageBreakdown: slippage.breakdown, failureChance, dexFeeBps: exec.dexFeeBps, grossReturnSol: 0, netReturnSol: -exec.networkFeeSol, netPnlSol: null, netPnlPercent: null, failureReason: 'Simulated SELL failed: slippage exceeded / transaction not landed', reason };
        const feeSol = exec.networkFeeSol + exec.priorityFeeSol;
        const executionPrice = Math.max(quotedPrice * (1 - bpsToMultiplier(slippage.slippageBps + exec.dexFeeBps)), 0);
        const tokenUnits = safeNumber(position.receivedTokenUnits, 0);
        const grossReturnSol = tokenUnits > 0 ? (tokenUnits * executionPrice) / assumedSolUsd : position.positionSize * (executionPrice / position.entryPrice);
        const netReturnSol = Math.max(grossReturnSol - feeSol, 0);
        const netPnlSol = netReturnSol - position.positionSize;
        return { ok: true, quotedPrice, executionPrice, feeSol, slippageBps: slippage.slippageBps, slippageBreakdown: slippage.breakdown, failureChance, dexFeeBps: exec.dexFeeBps, grossReturnSol, netReturnSol, netPnlSol, netPnlPercent: (netPnlSol / position.positionSize) * 100, failureReason: null, reason };
    }

    recoverOpenPosition() {
        if (this.hasRecovered) return;
        const recoveredPosition = storage.loadActivePosition();
        if (recoveredPosition) {
            this.currentPosition = recoveredPosition;
            console.log(chalk.yellow.bold('\n[RECOVERY] Melanjutkan monitoring posisi yang terbuka...'));
            this.startMonitoring();
            this.hasRecovered = true;
        }
    }

    async validateTokenOnChain(tokenAddress) {
        try {
            const tokenAccount = await this.connection.getAccountInfo(new PublicKey(tokenAddress));
            if (!tokenAccount) {
                activityLogger.log('RPC_WARNING', { message: 'Token account not found on-chain. Possible Rugpull.', tokenAddress });
                return false;
            }
            return true;
        } catch (error) {
            activityLogger.log('RPC_WARNING', { message: 'Token validation failed', tokenAddress, error: error.message });
            return false;
        }
    }

    getJupiterHeaders() {
        const headers = { Accept: 'application/json' };
        if (process.env.JUPITER_API_KEY) headers['x-api-key'] = process.env.JUPITER_API_KEY;
        return headers;
    }

    async getTokenDecimals(mint) {
        if (mint === SOL_MINT) return SOL_DECIMALS;
        if (this.decimalsCache.has(mint)) return this.decimalsCache.get(mint);
        try {
            const account = await this.connection.getParsedAccountInfo(new PublicKey(mint));
            const decimals = account.value?.data?.parsed?.info?.decimals;
            const parsedDecimals = Number.isFinite(Number(decimals)) ? Number(decimals) : 6;
            this.decimalsCache.set(mint, parsedDecimals);
            return parsedDecimals;
        } catch (error) {
            activityLogger.log('TOKEN_DECIMALS_ERROR', { mint, error: error.message });
            return 6;
        }
    }

    async getJupiterSellPrice(position, timeoutMs = null) {
        const markMiss = (reason, extra = {}) => {
            if (position) {
                position.lastJupiterMissAt = new Date().toISOString();
                position.lastJupiterMissReason = reason;
                position.lastJupiterMissExtra = extra;
            }

            activityLogger.log('JUPITER_QUOTE_MISS', {
                symbol: position?.symbol,
                address: position?.address,
                reason,
                ...extra
            });

            return null;
        };

        try {
            const pm = this.getPriceMonitoringConfig();
            const tokenUnits = safeNumber(position?.receivedTokenUnits, 0);

            if (!position?.address) {
                return markMiss('missing_position_address');
            }

            if (tokenUnits <= 0) {
                return markMiss('missing_or_zero_received_token_units', {
                    receivedTokenUnits: position?.receivedTokenUnits
                });
            }

            const decimals = await this.getTokenDecimals(position.address);
            const amount = Math.floor(tokenUnits * Math.pow(10, decimals));

            if (!Number.isFinite(amount) || amount <= 0) {
                return markMiss('invalid_quote_amount', {
                    tokenUnits,
                    decimals,
                    amount
                });
            }

            const params = {
                inputMint: position.address,
                outputMint: SOL_MINT,
                amount: String(amount),
                slippageBps: String(pm.jupiterSlippageBps),
                onlyDirectRoutes: String(pm.jupiterOnlyDirectRoutes)
            };

            const response = await axios.get(pm.jupiterQuoteUrl, {
                params,
                headers: this.getJupiterHeaders(),
                timeout: timeoutMs || pm.timeoutMs
            });

            const outAmountLamports = safeNumber(response.data?.outAmount, 0);

            if (outAmountLamports <= 0) {
                return markMiss('missing_or_zero_out_amount', {
                    responseData: response.data
                });
            }

            const outSol = outAmountLamports / Math.pow(10, SOL_DECIMALS);
            const tokenPriceUsd = (outSol / tokenUnits) * pm.assumedSolUsd;

            if (!Number.isFinite(tokenPriceUsd) || tokenPriceUsd <= 0) {
                return markMiss('invalid_calculated_jupiter_price', {
                    outSol,
                    tokenUnits,
                    assumedSolUsd: pm.assumedSolUsd,
                    tokenPriceUsd
                });
            }

            position.lastJupiterQuoteAt = new Date().toISOString();
            position.lastJupiterOutSol = outSol;
            position.lastJupiterPriceUsd = tokenPriceUsd;
            position.lastJupiterPriceImpactPct = response.data?.priceImpactPct;
            position.lastJupiterMissReason = null;
            position.lastJupiterMissExtra = null;

            return tokenPriceUsd;
        } catch (error) {
            const errorMessage = error.response?.data?.error || error.response?.data || error.message;

            activityLogger.log('JUPITER_QUOTE_ERROR', {
                symbol: position?.symbol,
                address: position?.address,
                error: errorMessage
            });

            if (position) {
                position.lastJupiterMissAt = new Date().toISOString();
                position.lastJupiterMissReason = 'jupiter_request_error';
                position.lastJupiterMissExtra = {
                    error: errorMessage
                };
            }

            return null;
        }
    }

    async getDexScreenerPrice(pairAddress, validateOnChain = false, timeoutMs = null) {
        try {
            const pm = this.getPriceMonitoringConfig();
            const resp = await axios.get(`${this.pairEndpoint}${pairAddress}`, { timeout: timeoutMs || pm.timeoutMs });
            if (!resp.data || !resp.data.pair) return null;
            const price = parseFloat(resp.data.pair.priceUsd);
            if (!Number.isFinite(price) || price <= 0) return null;
            if (!validateOnChain) return price;
            const tokenAddress = resp.data.pair.baseToken.address;
            const isValid = await this.validateTokenOnChain(tokenAddress);
            return isValid ? price : null;
        } catch (error) {
            if (error.response?.status === 429) {
                console.log(chalk.yellow.bold('\\n[⚠️ RATE LIMIT] Error 429: Terlalu banyak request. Memperlambat refresh...'));
                activityLogger.log('RATE_LIMIT', { message: 'DexScreener API returned 429 - Rate limit exceeded' });
            }
            return null;
        }
    }

    async getCurrentPrice(pairAddress, validateOnChain = false, timeoutMs = null) {
        return this.getDexScreenerPrice(pairAddress, validateOnChain, timeoutMs);
    }

    async getActivePositionPrice(timeoutMs = null) {
        const pm = this.getPriceMonitoringConfig();

        if (pm.source === 'jupiter') {
            const jupiterPrice = await this.getJupiterSellPrice(this.currentPosition, timeoutMs);

            if (jupiterPrice) {
                return { price: jupiterPrice, source: 'jupiter' };
            }

            const reason = this.currentPosition?.lastJupiterMissReason || 'unknown_jupiter_miss';

            console.log(chalk.yellow(
                `\n[JUPITER MISS] ${this.currentPosition?.symbol || 'UNKNOWN'}: ${reason}. ` +
                `Fallback DexScreener: ${pm.fallbackToDexScreener ? 'ON' : 'OFF'}`
            ));

            activityLogger.log('JUPITER_FALLBACK_DECISION', {
                symbol: this.currentPosition?.symbol,
                address: this.currentPosition?.address,
                reason,
                fallbackToDexScreener: pm.fallbackToDexScreener
            });

            storage.saveActivePosition(this.currentPosition);

            if (!pm.fallbackToDexScreener) {
                return { price: null, source: 'jupiter_miss' };
            }
        }

        const dexPrice = await this.getDexScreenerPrice(this.currentPosition.pairAddress, false, timeoutMs);
        return { price: dexPrice, source: dexPrice ? 'dexscreener' : 'dex_miss' };
    }

    async checkWalletMonopoly(tokenAddress) {
        try {
            console.log(chalk.cyan(`\\n[Monopoly Check] 🔍 Menganalisis distribusi wallet untuk ${tokenAddress}...`));
            const response = await axios.post(this.alchemyRpcUrl, { jsonrpc: '2.0', id: 1, method: 'getTokenLargestAccounts', params: [tokenAddress] }, { headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
            const largestAccounts = response.data?.result?.value;
            if (!largestAccounts) {
                console.log(chalk.yellow('[Monopoly Check] ⚠️ Gagal mendapatkan data wallet terbesar.'));
                return false;
            }
            const topHolders = largestAccounts.slice(0, 10);
            let totalSupply = 0;
            let topHolderAmount = 0;
            topHolders.forEach((account, index) => {
                const amount = parseFloat(account.amount);
                totalSupply += amount;
                if (index === 0) topHolderAmount = amount;
            });
            const monopolyPercent = totalSupply > 0 ? (topHolderAmount / totalSupply) * 100 : 0;
            console.log(chalk.gray(`   Top 10 holders: ${totalSupply.toFixed(0)} tokens`));
            console.log(chalk.gray(`   Wallet #1 memegang: ${topHolderAmount.toFixed(0)} tokens (${monopolyPercent.toFixed(2)}%)`));
            if (monopolyPercent > 70) {
                console.log(chalk.red.bold(`   ⚠️ WARNING: Wallet terbesar mengontrol ${monopolyPercent.toFixed(2)}% supply!`));
                activityLogger.log('MONOPOLY_DETECTED', { token: tokenAddress, monopolyPercent: monopolyPercent.toFixed(2) });
                return true;
            }
            console.log(chalk.green(`   ✅ Distribusi wallet sehat (${monopolyPercent.toFixed(2)}%)`));
            return false;
        } catch (error) {
            console.log(chalk.yellow(`[Monopoly Check] ⚠️ Error mengecek wallet: ${error.message}`));
            activityLogger.log('MONOPOLY_CHECK_ERROR', { token: tokenAddress, error: error.message });
            return false;
        }
    }

    async checkWashTrading(tokenAddress, pairAddress) {
        try {
            console.log(chalk.cyan(`\\n[Wash Trading Check] 🔍 Menganalisis aktivitas trading untuk ${tokenAddress}...`));
            const response = await axios.get(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}`, { headers: { Accept: 'application/json' }, timeout: 8000 });
            const attributes = response.data?.data?.attributes;
            if (!attributes) {
                console.log(chalk.yellow('[Wash Trading Check] ⚠️ Tidak ada data pool dari Gecko Terminal.'));
                return false;
            }
            const totalBuyTransactions = attributes.txns?.m5?.buys || attributes.transactions_5m || 0;
            const totalVolumeUsd = parseFloat(attributes.volume_usd || 0) || 0;
            const uniqueBuyersCount = attributes.unique_buyers_m5 || attributes.unique_traders_m5 || 0;
            const avgTransactionValue = totalBuyTransactions > 0 ? totalVolumeUsd / totalBuyTransactions : 0;
            const transactionsPerBuyer = uniqueBuyersCount > 0 ? totalBuyTransactions / uniqueBuyersCount : 0;
            console.log(chalk.gray(`   Total Transaksi Beli (5m): ${totalBuyTransactions}`));
            console.log(chalk.gray(`   Unique Buyers (5m): ${uniqueBuyersCount}`));
            console.log(chalk.gray(`   Total Volume: $${totalVolumeUsd.toFixed(2)}`));
            console.log(chalk.gray(`   Rata-rata per Transaksi: $${avgTransactionValue.toFixed(2)}`));
            console.log(chalk.gray(`   Transaksi per Buyer: ${transactionsPerBuyer.toFixed(1)}`));
            if (avgTransactionValue < 2 && totalBuyTransactions > 5) return true;
            if (transactionsPerBuyer > 20 && totalBuyTransactions > 10) return true;
            if (uniqueBuyersCount / totalBuyTransactions < 0.1 && totalBuyTransactions > 10) return true;
            console.log(chalk.green(`   ✅ Aktivitas trading terlihat natural (${uniqueBuyersCount} unique buyers, avg $${avgTransactionValue.toFixed(2)}/tx)`));
            return false;
        } catch (error) {
            console.log(chalk.yellow(`[Wash Trading Check] ⚠️ Error mengecek wash trading: ${error.message}`));
            activityLogger.log('WASH_TRADING_CHECK_ERROR', { token: tokenAddress, error: error.message });
            return false;
        }
    }

    getTokenHistoryScore(tokenAddress) {
        const trades = storage.getTradesByAddress(tokenAddress);
        let score = 0;
        trades.forEach(trade => {
            const pnl = safeNumber(trade.pnl, 0);
            const reason = String(trade.reason || '');
            if (pnl > 0) score += 1;
            if (reason.includes('Moon Target')) score += 2;
            if (pnl < 0) score -= 1;
            if (reason.includes('Stop Loss')) score -= 2;
            if (reason.includes('Time Limit') && pnl < 0) score -= 1;
        });
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
        if (safeNumber(tokenState.slCount, 0) >= ar.sessionBlacklistStopLossCount) {
            tokenState.blacklisted = true;
            state.tokenStats[address] = tokenState;
            storage.saveState(state);
            return { skip: true, reason: `Token mencapai ${ar.sessionBlacklistStopLossCount} stop loss dalam sesi ini.` };
        }
        const history = this.getTokenHistoryScore(address);
        if (history.lastNNegative) return { skip: true, reason: 'Tiga trade terakhir token ini negatif.' };
        if (history.score < ar.minTokenScore) return { skip: true, reason: `Token score terlalu rendah (${history.score}).` };
        return { skip: false };
    }

    async observeAndConfirm(token) {
        activityLogger.log('OBSERVATION_START', { symbol: token.baseToken.symbol });
        const obs = config.observation;
        const ar = this.getAdaptiveRiskConfig();
        const pm = this.getPriceMonitoringConfig();
        console.log(chalk.cyan(`\n[Observer] 🕵️ Menunda Entry. Mengawasi ${token.baseToken.symbol} selama ${obs.durationSeconds} detik...`));

        if (pm.validateOnChainOnce) {
            const isValid = await this.validateTokenOnChain(token.baseToken.address);
            if (!isValid) {
                console.log(chalk.yellow('\n[Observer] ❌ Ditolak: Token account tidak valid on-chain.'));
                return false;
            }
        }

        const prices = [];
        const startedAt = Date.now();
        const durationMs = safeNumber(obs.durationSeconds, 10) * 1000;
        while (Date.now() - startedAt < durationMs) {
            const currentPrice = await this.getDexScreenerPrice(token.pairAddress, false, pm.timeoutMs);
            if (currentPrice) prices.push(currentPrice);
            process.stdout.write(chalk.gray(`> Merekam aksi harga: ${prices.length} tick...\r`));
            await sleep(pm.observationIntervalMs);
        }

        if (prices.length < 3) {
            console.log(chalk.yellow('\n[Observer] ❌ Ditolak: Data harga tidak cukup stabil dari price feed.'));
            return false;
        }

        const uniquePrices = new Set(prices.map(price => Number(price).toPrecision(12))).size;
        const minUniquePrices = safeNumber(obs.minUniquePrices, 1);
        if (uniquePrices < minUniquePrices) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Variasi harga terlalu sedikit (${uniquePrices}/${minUniquePrices}).`));
            return false;
        }
        const flatObservation = this.isFlatObservation(uniquePrices);
        if (flatObservation) console.log(chalk.yellow('\n[Observer] ⚠️ Harga sangat flat. Entry tetap diizinkan, tetapi TP/SL akan diperketat.'));

        const isMonopolized = await this.checkWalletMonopoly(token.baseToken.address);
        if (isMonopolized) return false;
        const isWashTrading = await this.checkWashTrading(token.baseToken.address, token.pairAddress);
        if (isWashTrading) return false;

        const startPrice = prices[0];
        const endPrice = prices[prices.length - 1];
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);
        const trendPercent = ((endPrice - startPrice) / startPrice) * 100;
        if (trendPercent < -3) return false;
        const maxDropPercent = ((maxPrice - minPrice) / maxPrice) * 100;
        const maxAllowedDrop = safeNumber(obs.maxDumpPercent, 22);
        if (maxDropPercent > maxAllowedDrop) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Volatilitas terlalu tinggi (${maxDropPercent.toFixed(2)}% > ${maxAllowedDrop}%).`));
            return false;
        }
        const fromPeakPercent = ((maxPrice - endPrice) / maxPrice) * 100;
        if (fromPeakPercent > safeNumber(obs.maxFromPeakPercent, 10)) return false;
        const priceChanges = [];
        for (let i = 1; i < prices.length; i++) priceChanges.push(((prices[i] - prices[i - 1]) / prices[i - 1]) * 100);
        const meanChange = priceChanges.reduce((a, b) => a + b, 0) / priceChanges.length;
        const variance = priceChanges.reduce((a, b) => a + Math.pow(b - meanChange, 2), 0) / priceChanges.length;
        const volatility = Math.sqrt(variance);
        if (safeNumber(obs.rejectZeroMovement, false) && volatility === 0 && maxDropPercent === 0) return false;
        if (!flatObservation && volatility > ar.maxAllowedVolatility) return false;

        Object.assign(token, { volatility, priceRange: maxDropPercent, confirmedEntryPrice: endPrice, observedStartPrice: startPrice, observedMaxPrice: maxPrice, observedMinPrice: minPrice, uniquePrices, flatObservation });
        console.log(chalk.green.bold('\n[Observer] ✅ TERKONFIRMASI! Trend positif terdeteksi. Mengeksekusi BUY!'));
        console.log(chalk.gray(`   Start: $${startPrice.toFixed(6)} | End/Entry: $${endPrice.toFixed(6)} | Range: ${maxDropPercent.toFixed(2)}% | Unique: ${uniquePrices} | Ticks: ${prices.length} | Flat: ${flatObservation}`));
        console.log(chalk.gray(`   Volatility (StdDev): ${volatility.toFixed(4)}% per tick`));
        return true;
    }

    getPositionRiskProfile(token, volatility) {
        const flat = this.getAdaptiveRiskConfig().flatObservation || {};
        if (token.flatObservation && flat.enabled !== false) {
            return { trailingStopPercent: safeNumber(flat.trailingStopPercent, 1.5), targetProfitPercent: safeNumber(flat.targetProfitPercent, 5), stopLossPercent: safeNumber(flat.stopLossPercent, 4), trailingStartPercent: safeNumber(flat.trailingStartPercent, 3), timeLimitMinutes: safeNumber(flat.timeLimitMinutes, 4) };
        }
        const trailingStopPercent = volatility > 1 ? 8 : volatility >= 0.5 ? 5 : 2;
        const targetProfitPercent = volatility > 1 ? 15 : volatility >= 0.5 ? 10 : 7;
        return { trailingStopPercent, targetProfitPercent, stopLossPercent: config.trading.stopLossPercent, trailingStartPercent: config.trading.trailingStartPercent, timeLimitMinutes: config.trading.timeLimitMinutes };
    }

    async openPosition(token) {
        if (this.currentPosition) return;
        const historyGuard = this.shouldSkipTokenByHistory(token);
        if (historyGuard.skip) {
            console.log(chalk.yellow(`[ENTRY SKIPPED] ${token.baseToken.symbol}: ${historyGuard.reason}`));
            activityLogger.log('ENTRY_SKIPPED_HISTORY', { symbol: token.baseToken.symbol, address: token.baseToken.address, reason: historyGuard.reason });
            return;
        }
        const quotedPrice = Number(token.confirmedEntryPrice);
        if (!Number.isFinite(quotedPrice) || quotedPrice <= 0) return;
        const positionSize = Number(config.trading.positionSize);
        const buyExecution = this.simulateBuyExecution(quotedPrice, positionSize, token);
        if (!buyExecution.ok) {
            console.log(chalk.red.bold(`\n[BUY FAILED] ${token.baseToken.symbol}: ${buyExecution.failureReason}`));
            activityLogger.log('PAPER_BUY_FAILED', { symbol: token.baseToken.symbol, address: token.baseToken.address, pairAddress: token.pairAddress, ...buyExecution });
            await telegram.sendMessage(`🔴 *PAPER BUY FAILED*\nToken: ${token.baseToken.symbol}\nReason: ${buyExecution.failureReason}\nFee Lost: ${buyExecution.feeSol.toFixed(6)} SOL`);
            return;
        }
        const volatility = token.volatility || 0;
        const riskProfile = this.getPositionRiskProfile(token, volatility);
        const liquidityUsd = Number(token.liquidity?.usd || 0);
        this.currentPosition = {
            symbol: token.baseToken.symbol,
            address: token.baseToken.address,
            pairAddress: token.pairAddress,
            quotedEntryPrice: quotedPrice,
            entryPrice: buyExecution.executionPrice,
            maxPrice: buyExecution.executionPrice,
            positionSize,
            openedAt: new Date().toISOString(),
            receivedTokenUnits: buyExecution.receivedTokenUnits,
            buyFeeSol: buyExecution.feeSol,
            buySlippageBps: buyExecution.slippageBps,
            buySlippageBreakdown: buyExecution.slippageBreakdown,
            buyFailureChance: buyExecution.failureChance,
            dexFeeBps: buyExecution.dexFeeBps,
            failedSellAttempts: 0,
            liquidityUsd,
            priceRange: token.priceRange,
            observedStartPrice: token.observedStartPrice,
            observedMaxPrice: token.observedMaxPrice,
            observedMinPrice: token.observedMinPrice,
            uniquePrices: token.uniquePrices,
            flatObservation: token.flatObservation,
            dynamicTrailingStopPercent: riskProfile.trailingStopPercent,
            dynamicTargetProfitPercent: riskProfile.targetProfitPercent,
            dynamicStopLossPercent: riskProfile.stopLossPercent,
            dynamicTrailingStartPercent: riskProfile.trailingStartPercent,
            dynamicTimeLimitMinutes: riskProfile.timeLimitMinutes,
            volatility
        };
        storage.saveActivePosition(this.currentPosition);
        console.log(chalk.green.bold(`\n[BUY] Mengunci target: ${this.currentPosition.symbol}`));
        console.log(chalk.gray(`Executed Entry: $${this.currentPosition.entryPrice} | TP: ${riskProfile.targetProfitPercent}% | SL: ${riskProfile.stopLossPercent}% | Flat: ${!!token.flatObservation}`));
        await telegram.notifyTrade('BUY', { symbol: this.currentPosition.symbol, price: this.currentPosition.entryPrice, quotedPrice, address: this.currentPosition.address, feeSol: buyExecution.feeSol, slippageBps: buyExecution.slippageBps });
        this.startMonitoring();
    }

    startMonitoring() {
        if (this.isPolling) return;
        console.log(chalk.blue(`Memulai monitoring non-overlap untuk ${this.currentPosition.symbol}...`));
        this.isPolling = true;
        this.pollPositionLoop();
    }

    async pollPositionLoop() {
        const pm = this.getPriceMonitoringConfig();
        while (this.isPolling && this.currentPosition) {
            const startedAt = Date.now();
            try {
                await this.checkPositionOnce(pm);
            } catch (error) {
                console.error(chalk.red('\nError Monitoring:'), error.message);
            }
            const elapsed = Date.now() - startedAt;
            const delay = Math.max(pm.minDelayMs, pm.activeIntervalMs - elapsed);
            await sleep(delay);
        }
        this.isPolling = false;
    }

    async checkPositionOnce(pm = this.getPriceMonitoringConfig()) {
        if (!this.currentPosition) return;
        const quote = await this.getActivePositionPrice(pm.timeoutMs);
        if (!quote.price) {
            process.stdout.write(chalk.gray(`\rMonitoring ${this.currentPosition.symbol}: price tick missed (${quote.source})    `));
            return;
        }
        const currentPrice = quote.price;
        const pnl = ((currentPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice) * 100;
        if (currentPrice > this.currentPosition.maxPrice) {
            this.currentPosition.maxPrice = currentPrice;
            this.currentPosition.maxPriceUpdatedAt = new Date().toISOString();
            storage.saveActivePosition(this.currentPosition);
        }
        const maxPnl = ((this.currentPosition.maxPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice) * 100;
        process.stdout.write(chalk.white(`\rMonitoring ${this.currentPosition.symbol}: PNL ${pnl.toFixed(2)}% | Max ${maxPnl.toFixed(2)}% | Src ${quote.source} | Flat ${this.currentPosition.flatObservation ? 'Y' : 'N'}    `));
        this.checkExitConditions(currentPrice, pnl, maxPnl);
    }

    stopMonitoring() {
        this.isPolling = false;
        if (this.checkInterval) clearInterval(this.checkInterval);
        this.checkInterval = null;
    }

    getElapsedSeconds() {
        return this.currentPosition?.openedAt ? (Date.now() - new Date(this.currentPosition.openedAt).getTime()) / 1000 : 0;
    }

    checkAdaptiveExit(currentPrice, pnl, maxPnl) {
        const ar = this.getAdaptiveRiskConfig();
        const flat = this.currentPosition.flatObservation ? (ar.flatObservation || {}) : null;
        const elapsedSeconds = this.getElapsedSeconds();
        const elapsedMinutes = elapsedSeconds / 60;
        const earlyRules = flat ? (flat.earlyExitRules || ar.earlyExitRules) : ar.earlyExitRules;
        const minPnlAfterSeconds = flat ? safeNumber(flat.minPnlAfterSeconds, 60) : ar.minPnlAfterSeconds;
        const minPnlRequired = flat ? safeNumber(flat.minPnlRequired, 1) : ar.minPnlRequired;
        for (const tier of [...ar.profitLockTiers].sort((a, b) => safeNumber(b.maxPnl) - safeNumber(a.maxPnl))) {
            if (maxPnl >= safeNumber(tier.maxPnl) && pnl < safeNumber(tier.lockPnl)) return `🔒 Tiered Profit Lock: Max ${maxPnl.toFixed(2)}%, turun di bawah ${tier.lockPnl}%`;
        }
        for (const rule of earlyRules) {
            if (elapsedSeconds <= safeNumber(rule.seconds) && pnl <= safeNumber(rule.maxLossPercent, -999)) return `⚡ Early Exit: ${elapsedSeconds.toFixed(0)}s PNL ${pnl.toFixed(2)}%`;
        }
        if (elapsedSeconds >= minPnlAfterSeconds && maxPnl < minPnlRequired) return `⏱️ Weakness Exit: ${elapsedSeconds.toFixed(0)}s Max PNL belum ${minPnlRequired}%`;
        for (const rule of ar.stagnationRules) {
            if (elapsedMinutes < safeNumber(rule.minutes)) continue;
            if (rule.minMaxPnl !== undefined && maxPnl < safeNumber(rule.minMaxPnl)) return `⌛ Stagnation Exit: ${elapsedMinutes.toFixed(1)}m Max PNL < ${rule.minMaxPnl}%`;
            if (rule.exitIfPnlBelow !== undefined && pnl < safeNumber(rule.exitIfPnlBelow)) return `⌛ Stagnation Exit: ${elapsedMinutes.toFixed(1)}m PNL < ${rule.exitIfPnlBelow}%`;
        }
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
        if (pnl >= trailingStartPercent) {
            const trailThreshold = this.currentPosition.maxPrice * (1 - trailingStopPercent / 100);
            if (currentPrice <= trailThreshold) return this.closePosition(currentPrice, pnl, `🛡️ Trailing Stop: Locked at ${pnl.toFixed(2)}% (Dynamic ${trailingStopPercent}%)`);
        }
        if (pnl <= -stopLossPercent) return this.closePosition(currentPrice, pnl, `❌ Stop Loss Terkena (${stopLossPercent}%)`);
        if (this.getElapsedSeconds() / 60 >= timeLimitMinutes) return this.closePosition(currentPrice, pnl, `⌛ Time Limit: ${timeLimitMinutes}m`);
    }

    updateGlobalPauseFromRecentPerformance(state) {
        const ar = this.getAdaptiveRiskConfig();
        const cRisk = config.riskManagement;
        const portfolio = storage.getPortfolio();
        const now = Date.now();
        if (portfolio.peakBalance > 0) {
            const drawdown = ((portfolio.peakBalance - portfolio.currentBalance) / portfolio.peakBalance) * 100;
            if (drawdown >= ar.maxPortfolioDrawdownPercent) {
                state.globalPauseUntil = Math.max(state.globalPauseUntil || 0, now + cRisk.globalPauseMinutes * 60 * 1000);
                return `Portfolio drawdown ${drawdown.toFixed(2)}% >= ${ar.maxPortfolioDrawdownPercent}%`;
            }
        }
        const recentTrades = storage.getRecentTrades(ar.recentTradeCount);
        if (recentTrades.length >= ar.recentTradeCount) {
            const recentTotalPnl = recentTrades.reduce((sum, trade) => sum + safeNumber(trade.pnl), 0);
            if (recentTotalPnl <= ar.recentTradesMaxTotalPnlPercent) {
                state.globalPauseUntil = Math.max(state.globalPauseUntil || 0, now + cRisk.globalPauseMinutes * 60 * 1000);
                return `${ar.recentTradeCount} trade terakhir total PNL ${recentTotalPnl.toFixed(2)}%`;
            }
        }
        const stopLossBurst = storage.getTrades().filter(trade => now - new Date(trade.closedAt || 0).getTime() <= ar.stopLossBurstWindowMinutes * 60 * 1000 && String(trade.reason || '').includes('Stop Loss'));
        if (stopLossBurst.length >= ar.stopLossBurstCount) {
            state.globalPauseUntil = Math.max(state.globalPauseUntil || 0, now + cRisk.globalPauseMinutes * 60 * 1000);
            return `${stopLossBurst.length} stop loss dalam ${ar.stopLossBurstWindowMinutes} menit`;
        }
        return null;
    }

    async closePosition(price, pnl, reason) {
        this.stopMonitoring();
        const cRisk = config.riskManagement;
        const ar = this.getAdaptiveRiskConfig();
        const tokenAddress = this.currentPosition.address;
        const sellExecution = this.simulateSellExecution(price, this.currentPosition, reason);
        if (!sellExecution.ok) {
            this.currentPosition.failedSellAttempts = safeNumber(this.currentPosition.failedSellAttempts) + 1;
            this.currentPosition.lastSellFailureAt = new Date().toISOString();
            this.currentPosition.lastSellFailureReason = sellExecution.failureReason;
            this.currentPosition.accumulatedFailedSellFeesSol = safeNumber(this.currentPosition.accumulatedFailedSellFeesSol) + sellExecution.feeSol;
            storage.saveActivePosition(this.currentPosition);
            activityLogger.log('PAPER_SELL_FAILED', { symbol: this.currentPosition.symbol, address: tokenAddress, attempts: this.currentPosition.failedSellAttempts, ...sellExecution });
            await telegram.sendMessage(`🟠 *PAPER SELL FAILED*\nToken: ${this.currentPosition.symbol}\nReason: ${sellExecution.failureReason}\nAttempt: ${this.currentPosition.failedSellAttempts}/${this.getPaperExecutionConfig().maxSellFailureRetries}`);
            this.startMonitoring();
            return;
        }
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
            if (tradeData.netPnlSol < 0) {
                state.consecutiveLosses += 1;
                tState.slCount += 1;
                if (tradeData.pnl <= cRisk.rugpullThresholdPercent) { tState.blacklisted = true; alertMsg = `🚨 *RUGPULL DETECTED* (${tradeData.pnl.toFixed(2)}%).`; }
                else if (tState.slCount >= ar.sessionBlacklistStopLossCount) { tState.blacklisted = true; alertMsg = `🚫 *SESSION BLACKLIST*. Token kena SL ${tState.slCount}x.`; }
                else if (tState.slCount >= ar.maxStopLossCountBeforeCooldown) { tState.cooldownUntil = Date.now() + ar.extendedCooldownHours * 60 * 60 * 1000; alertMsg = `⏸️ *Extended Cooldown*. Token kena SL ${tState.slCount}x.`; }
                else if (tState.slCount >= 2) { tState.cooldownUntil = Date.now() + cRisk.slCooldown2xMinutes * 60 * 1000; alertMsg = `⏸️ *Kena SL 2x*. Cooldown token ${cRisk.slCooldown2xMinutes} menit.`; }
                else { tState.cooldownUntil = Date.now() + cRisk.slCooldown1xMinutes * 60 * 1000; alertMsg = `⏳ *Kena SL 1x*. Token cooldown ${cRisk.slCooldown1xMinutes} menit.`; }
                if (state.consecutiveLosses >= cRisk.maxConsecutiveLosses) { state.globalPauseUntil = Date.now() + cRisk.globalPauseMinutes * 60 * 1000; state.consecutiveLosses = 0; }
            } else {
                state.consecutiveLosses = 0;
                tState.cooldownUntil = Date.now() + 5 * 60 * 1000;
            }
            state.tokenStats[tokenAddress] = tState;
            const pauseReason = this.updateGlobalPauseFromRecentPerformance(state);
            storage.saveState(state);
            await telegram.notifyTrade('SELL', tradeData);
            if (alertMsg) await telegram.sendMessage(alertMsg);
            if (pauseReason) await telegram.sendMessage(`🛑 *GLOBAL PAUSE DIAKTIFKAN*\n${pauseReason}\nPause selama ${cRisk.globalPauseMinutes} menit.`);
        } catch (error) {
            console.error('Gagal menutup posisi:', error.message);
        } finally {
            this.currentPosition = null;
            this.hasRecovered = false;
        }
    }
}

module.exports = new EngineService();