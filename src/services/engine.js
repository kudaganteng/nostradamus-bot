const axios = require('axios');
const chalk = require('chalk');
const config = require('../../config.json');
const telegram = require('./telegram');
const storage = require('../utils/storage');
const scanner = require('./scanner');
const activityLogger = require('../utils/activityLogger');
const { Connection, PublicKey } = require('@solana/web3.js');
require('dotenv').config();

function getAlchemyRpcUrl() {
    const url = process.env.ALCHEMY_RPC_URL;

    if (!url || !url.trim()) {
        throw new Error('ALCHEMY_RPC_URL belum diisi. Tambahkan ALCHEMY_RPC_URL ke file .env.');
    }

    return url.trim();
}

function clampProbability(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, 0), 1);
}

function bpsToMultiplier(bps) {
    return Number(bps || 0) / 10000;
}

class EngineService {
    constructor() {
        storage.init();
        this.alchemyRpcUrl = getAlchemyRpcUrl();
        this.connection = new Connection(this.alchemyRpcUrl, 'confirmed');
        this.checkInterval = null;
        this.pairEndpoint = 'https://api.dexscreener.com/latest/dex/pairs/solana/';
        this.hasRecovered = false;
        this.currentPosition = storage.loadActivePosition();
        
        if (this.currentPosition) {
            console.log(chalk.yellow.bold('\n[RECOVERY] Melanjutkan monitoring posisi yang terbuka...'));
            this.startMonitoring();
            this.hasRecovered = true;
        } else {
            this.currentPosition = null;
        }
    }

    getPaperExecutionConfig() {
        return {
            enabled: config.paperExecution?.enabled !== false,
            buySlippageBps: Number(config.paperExecution?.buySlippageBps || 0),
            sellSlippageBps: Number(config.paperExecution?.sellSlippageBps || 0),
            dexFeeBps: Number(config.paperExecution?.dexFeeBps || 0),
            networkFeeSol: Number(config.paperExecution?.networkFeeSol || 0),
            priorityFeeSol: Number(config.paperExecution?.priorityFeeSol || 0),
            buyFailureChance: clampProbability(config.paperExecution?.buyFailureChance, 0),
            sellFailureChance: clampProbability(config.paperExecution?.sellFailureChance, 0),
            maxSellFailureRetries: Math.max(0, Number(config.paperExecution?.maxSellFailureRetries || 0)),
            sellRetryPenaltyBps: Number(config.paperExecution?.sellRetryPenaltyBps || 0)
        };
    }

    shouldSimulateFailure(chance) {
        return Math.random() < chance;
    }

    simulateBuyExecution(quotedPrice, positionSizeSol) {
        const exec = this.getPaperExecutionConfig();

        if (!exec.enabled) {
            return {
                ok: true,
                quotedPrice,
                executionPrice: quotedPrice,
                feeSol: 0,
                slippageBps: 0,
                dexFeeBps: 0,
                receivedTokenUnits: positionSizeSol / quotedPrice,
                spentSol: positionSizeSol,
                failureReason: null
            };
        }

        if (this.shouldSimulateFailure(exec.buyFailureChance)) {
            return {
                ok: false,
                quotedPrice,
                executionPrice: null,
                feeSol: exec.networkFeeSol,
                slippageBps: exec.buySlippageBps,
                dexFeeBps: exec.dexFeeBps,
                receivedTokenUnits: 0,
                spentSol: exec.networkFeeSol,
                failureReason: 'Simulated BUY failed: RPC timeout / route changed / blockhash expired'
            };
        }

        const feeSol = exec.networkFeeSol + exec.priorityFeeSol;
        const effectiveSpendSol = Math.max(positionSizeSol - feeSol, 0);
        const executionPrice = quotedPrice * (1 + bpsToMultiplier(exec.buySlippageBps + exec.dexFeeBps));
        const receivedTokenUnits = effectiveSpendSol / executionPrice;

        return {
            ok: true,
            quotedPrice,
            executionPrice,
            feeSol,
            slippageBps: exec.buySlippageBps,
            dexFeeBps: exec.dexFeeBps,
            receivedTokenUnits,
            spentSol: positionSizeSol,
            failureReason: null
        };
    }

    simulateSellExecution(quotedPrice, position, reason) {
        const exec = this.getPaperExecutionConfig();
        const failedSellAttempts = Number(position.failedSellAttempts || 0);
        const totalSlippageBps = exec.sellSlippageBps + (failedSellAttempts * exec.sellRetryPenaltyBps);

        if (!exec.enabled) {
            const grossReturnSol = position.receivedTokenUnits
                ? position.receivedTokenUnits * quotedPrice
                : position.positionSize * (quotedPrice / position.entryPrice);
            const netPnlSol = grossReturnSol - position.positionSize;

            return {
                ok: true,
                quotedPrice,
                executionPrice: quotedPrice,
                feeSol: 0,
                slippageBps: 0,
                dexFeeBps: 0,
                grossReturnSol,
                netReturnSol: grossReturnSol,
                netPnlSol,
                netPnlPercent: (netPnlSol / position.positionSize) * 100,
                failureReason: null,
                reason
            };
        }

        if (this.shouldSimulateFailure(exec.sellFailureChance) && failedSellAttempts < exec.maxSellFailureRetries) {
            return {
                ok: false,
                quotedPrice,
                executionPrice: null,
                feeSol: exec.networkFeeSol,
                slippageBps: totalSlippageBps,
                dexFeeBps: exec.dexFeeBps,
                grossReturnSol: 0,
                netReturnSol: -exec.networkFeeSol,
                netPnlSol: null,
                netPnlPercent: null,
                failureReason: 'Simulated SELL failed: slippage exceeded / transaction not landed',
                reason
            };
        }

        const feeSol = exec.networkFeeSol + exec.priorityFeeSol;
        const executionPrice = quotedPrice * (1 - bpsToMultiplier(totalSlippageBps + exec.dexFeeBps));
        const safeExecutionPrice = Math.max(executionPrice, 0);
        const tokenUnits = Number(position.receivedTokenUnits || 0);
        const grossReturnSol = tokenUnits > 0
            ? tokenUnits * safeExecutionPrice
            : position.positionSize * (safeExecutionPrice / position.entryPrice);
        const netReturnSol = Math.max(grossReturnSol - feeSol, 0);
        const netPnlSol = netReturnSol - position.positionSize;

        return {
            ok: true,
            quotedPrice,
            executionPrice: safeExecutionPrice,
            feeSol,
            slippageBps: totalSlippageBps,
            dexFeeBps: exec.dexFeeBps,
            grossReturnSol,
            netReturnSol,
            netPnlSol,
            netPnlPercent: (netPnlSol / position.positionSize) * 100,
            failureReason: null,
            reason
        };
    }
    
    recoverOpenPosition() {
        if (this.hasRecovered) {
            console.log(chalk.gray('[Recovery] Recovery sudah dilakukan sebelumnya, melewatkan...'));
            return;
        }
        
        const recoveredPosition = storage.loadActivePosition();
        if (recoveredPosition) {
            this.currentPosition = recoveredPosition;
            console.log(chalk.yellow.bold('\n[RECOVERY] Melanjutkan monitoring posisi yang terbuka...'));
            this.startMonitoring();
            this.hasRecovered = true;
        }
    }

    async getCurrentPrice(pairAddress, validateOnChain = false) {
        try {
            const resp = await axios.get(`${this.pairEndpoint}${pairAddress}`, { timeout: 3000 });
            if (!resp.data || !resp.data.pair) return null;

            const price = parseFloat(resp.data.pair.priceUsd);
            if (!validateOnChain) return price;

            const tokenAddress = resp.data.pair.baseToken.address;
            const tokenAccount = await this.connection.getAccountInfo(new PublicKey(tokenAddress));
            if (!tokenAccount) {
                activityLogger.log('RPC_WARNING', { message: 'Token account not found on-chain. Possible Rugpull.' });
                return null;
            }

            return price;
        } catch (error) {
            if (error.response && error.response.status === 429) {
                console.log(chalk.yellow.bold('\\n[⚠️ RATE LIMIT] Error 429: Terlalu banyak request. Memperlambat refresh...'));
                activityLogger.log('RATE_LIMIT', { message: 'DexScreener API returned 429 - Rate limit exceeded' });
            }
            return null;
        }
    }

    async checkWalletMonopoly(tokenAddress) {
        try {
            console.log(chalk.cyan(`\\n[Monopoly Check] 🔍 Menganalisis distribusi wallet untuk ${tokenAddress}...`));
            
            const response = await axios.post(this.alchemyRpcUrl, {
                jsonrpc: "2.0",
                id: 1,
                method: "getTokenLargestAccounts",
                params: [tokenAddress]
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 5000
            });

            if (!response.data || !response.data.result || !response.data.result.value) {
                console.log(chalk.yellow('[Monopoly Check] ⚠️ Gagal mendapatkan data wallet terbesar.'));
                return false;
            }

            const largestAccounts = response.data.result.value;
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

            const MONOPOLY_THRESHOLD = 70;
            if (monopolyPercent > MONOPOLY_THRESHOLD) {
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
            const geckoUrl = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}`;
            const response = await axios.get(geckoUrl, { headers: { 'Accept': 'application/json' }, timeout: 8000 });

            if (!response.data || !response.data.data) {
                console.log(chalk.yellow('[Wash Trading Check] ⚠️ Tidak ada data pool dari Gecko Terminal.'));
                return false;
            }

            const attributes = response.data.data.attributes || {};
            const txCount = attributes.txns ? attributes.txns.m5.buys : 0;
            const volumeUsd = attributes.volume_usd || 0;
            const uniqueBuyersM5 = attributes.unique_buyers_m5 || 0;
            const totalBuyTransactions = txCount > 0 ? txCount : (attributes.transactions_5m || 0);
            const totalVolumeUsd = parseFloat(volumeUsd) || 0;
            const uniqueBuyersCount = uniqueBuyersM5 > 0 ? uniqueBuyersM5 : (attributes.unique_traders_m5 || 0);
            const avgTransactionValue = totalBuyTransactions > 0 ? (totalVolumeUsd / totalBuyTransactions) : 0;
            const transactionsPerBuyer = uniqueBuyersCount > 0 ? (totalBuyTransactions / uniqueBuyersCount) : 0;

            console.log(chalk.gray(`   Total Transaksi Beli (5m): ${totalBuyTransactions}`));
            console.log(chalk.gray(`   Unique Buyers (5m): ${uniqueBuyersCount}`));
            console.log(chalk.gray(`   Total Volume: $${totalVolumeUsd.toFixed(2)}`));
            console.log(chalk.gray(`   Rata-rata per Transaksi: $${avgTransactionValue.toFixed(2)}`));
            console.log(chalk.gray(`   Transaksi per Buyer: ${transactionsPerBuyer.toFixed(1)}`));

            const MIN_AVG_TRANSACTION = 2;
            if (avgTransactionValue < MIN_AVG_TRANSACTION && totalBuyTransactions > 5) {
                console.log(chalk.red.bold(`   ⚠️ WASH TRADING DETECTED: Rata-rata transaksi hanya $${avgTransactionValue.toFixed(2)} (Fake Volume!)`));
                activityLogger.log('WASH_TRADING_DETECTED', { token: tokenAddress, reason: 'low_avg_transaction', avgTransactionValue: avgTransactionValue.toFixed(2), totalVolume: totalVolumeUsd.toFixed(2), totalTransactions: totalBuyTransactions, uniqueBuyers: uniqueBuyersCount });
                return true;
            }

            const MAX_TRANSACTIONS_PER_BUYER = 20;
            if (transactionsPerBuyer > MAX_TRANSACTIONS_PER_BUYER && totalBuyTransactions > 10) {
                console.log(chalk.red.bold(`   ⚠️ WASH TRADING DETECTED: ${transactionsPerBuyer.toFixed(1)} transaksi per buyer (Bot Activity!)`));
                activityLogger.log('WASH_TRADING_DETECTED', { token: tokenAddress, reason: 'high_transactions_per_buyer', transactionsPerBuyer: transactionsPerBuyer.toFixed(1), totalTransactions: totalBuyTransactions, uniqueBuyers: uniqueBuyersCount });
                return true;
            }

            const buyerRatio = uniqueBuyersCount / totalBuyTransactions;
            const MIN_BUYER_RATIO = 0.1;
            if (buyerRatio < MIN_BUYER_RATIO && totalBuyTransactions > 10) {
                console.log(chalk.red.bold(`   ⚠️ WASH TRADING DETECTED: Hanya ${uniqueBuyersCount} unique buyers dari ${totalBuyTransactions} transaksi!`));
                activityLogger.log('WASH_TRADING_DETECTED', { token: tokenAddress, reason: 'low_unique_buyer_ratio', buyerRatio: buyerRatio.toFixed(3), totalTransactions: totalBuyTransactions, uniqueBuyers: uniqueBuyersCount });
                return true;
            }

            console.log(chalk.green(`   ✅ Aktivitas trading terlihat natural (${uniqueBuyersCount} unique buyers, avg $${avgTransactionValue.toFixed(2)}/tx)`));
            return false;
        } catch (error) {
            console.log(chalk.yellow(`[Wash Trading Check] ⚠️ Error mengecek wash trading: ${error.message}`));
            activityLogger.log('WASH_TRADING_CHECK_ERROR', { token: tokenAddress, error: error.message });
            return false;
        }
    }

    async observeAndConfirm(token) {
        activityLogger.log("OBSERVATION_START", { symbol: token.baseToken.symbol });
        const obs = config.observation;
        console.log(chalk.cyan(`\n[Observer] 🕵️ Menunda Entry. Mengawasi ${token.baseToken.symbol} selama ${obs.durationSeconds} detik...`));

        let prices = [];
        const realTimeInterval = 1;
        const iterations = Math.floor(obs.durationSeconds / realTimeInterval);

        for (let i = 0; i < iterations; i++) {
            const currentPrice = await this.getCurrentPrice(token.pairAddress, true);
            if (currentPrice) prices.push(currentPrice);
            process.stdout.write(chalk.gray(`> Merekam aksi harga: ${prices.length}/${iterations} detik...\r`));
            await new Promise(resolve => setTimeout(resolve, realTimeInterval * 1000));
        }

        if (prices.length < 3) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Data harga tidak cukup stabil dari RPC.`));
            return false;
        }

        const isMonopolized = await this.checkWalletMonopoly(token.baseToken.address);
        if (isMonopolized) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Terdeteksi monopoli wallet pada token ini.`));
            return false;
        }

        const isWashTrading = await this.checkWashTrading(token.baseToken.address, token.pairAddress);
        if (isWashTrading) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Terdeteksi Wash Trading / Bot Activity pada token ini.`));
            return false;
        }

        const startPrice = prices[0];
        const endPrice = prices[prices.length - 1];
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);

        const trendPercent = ((endPrice - startPrice) / startPrice) * 100;
        if (trendPercent < -3) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Trend negatif (${trendPercent.toFixed(2)}%).`));
            return false;
        }

        const maxDropPercent = ((maxPrice - minPrice) / maxPrice) * 100;
        if (maxDropPercent > 25) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Volatilitas terlalu tinggi (${maxDropPercent.toFixed(2)}%).`));
            return false;
        }

        const fromPeakPercent = ((maxPrice - endPrice) / maxPrice) * 100;
        if (fromPeakPercent > 10) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Harga turun terlalu jauh dari puncak (${fromPeakPercent.toFixed(2)}%).`));
            return false;
        }

        const priceChanges = [];
        for (let i = 1; i < prices.length; i++) {
            const change = ((prices[i] - prices[i - 1]) / prices[i - 1]) * 100;
            priceChanges.push(change);
        }
        const meanChange = priceChanges.reduce((a, b) => a + b, 0) / priceChanges.length;
        const variance = priceChanges.reduce((a, b) => a + Math.pow(b - meanChange, 2), 0) / priceChanges.length;
        const volatility = Math.sqrt(variance);
        
        token.volatility = volatility;
        token.priceRange = maxDropPercent;
        token.confirmedEntryPrice = endPrice;
        token.observedStartPrice = startPrice;
        token.observedMaxPrice = maxPrice;
        token.observedMinPrice = minPrice;
        
        console.log(chalk.green.bold(`\n[Observer] ✅ TERKONFIRMASI! Trend positif terdeteksi. Mengeksekusi BUY!`));
        console.log(chalk.gray(`   Start: $${startPrice.toFixed(6)} | End/Entry: $${endPrice.toFixed(6)} | Range: ${maxDropPercent.toFixed(2)}%`));
        console.log(chalk.gray(`   Volatility (StdDev): ${volatility.toFixed(4)}% per detik`));
        return true;
    }

    async openPosition(token) {
        if (this.currentPosition) {
            console.log(chalk.yellow("Percobaan membuka posisi ditolak: Masih ada trade yang berjalan."));
            return;
        }

        const quotedPrice = Number(token.confirmedEntryPrice);
        if (!Number.isFinite(quotedPrice) || quotedPrice <= 0) {
            console.log(chalk.red("[BUY] Dibatalkan: confirmedEntryPrice tidak valid dari observer."));
            activityLogger.log('BUY_ABORTED_INVALID_ENTRY_PRICE', { symbol: token.baseToken?.symbol, pairAddress: token.pairAddress, confirmedEntryPrice: token.confirmedEntryPrice });
            return;
        }

        const positionSize = Number(config.trading.positionSize);
        const buyExecution = this.simulateBuyExecution(quotedPrice, positionSize);

        if (!buyExecution.ok) {
            console.log(chalk.red.bold(`\n[BUY FAILED] ${token.baseToken.symbol}: ${buyExecution.failureReason}`));
            console.log(chalk.gray(`Simulated fee lost: ${buyExecution.feeSol.toFixed(6)} SOL`));
            activityLogger.log('PAPER_BUY_FAILED', { symbol: token.baseToken.symbol, address: token.baseToken.address, pairAddress: token.pairAddress, ...buyExecution });
            await telegram.sendMessage(`🔴 *PAPER BUY FAILED*\nToken: ${token.baseToken.symbol}\nReason: ${buyExecution.failureReason}\nFee Lost: ${buyExecution.feeSol.toFixed(6)} SOL`);
            return;
        }
        
        const volatility = token.volatility || 0;
        const priceRange = token.priceRange || 0;
        let dynamicTrailingStopPercent;
        if (volatility > 1.0) dynamicTrailingStopPercent = 8;
        else if (volatility >= 0.5) dynamicTrailingStopPercent = 5;
        else dynamicTrailingStopPercent = 2;
        
        let dynamicTargetProfitPercent;
        if (volatility > 1.0) dynamicTargetProfitPercent = 15;
        else if (volatility >= 0.5) dynamicTargetProfitPercent = 10;
        else dynamicTargetProfitPercent = 7;
        
        console.log(chalk.cyan(`\n[Volatility Analysis] Volatilitas: ${volatility.toFixed(4)}% | Price Range: ${priceRange.toFixed(2)}%`));
        console.log(chalk.green(`   Dynamic Trailing Stop: ${dynamicTrailingStopPercent}%`));
        console.log(chalk.green(`   Dynamic Take Profit: ${dynamicTargetProfitPercent}%`));

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
            dexFeeBps: buyExecution.dexFeeBps,
            failedSellAttempts: 0,
            observedStartPrice: token.observedStartPrice,
            observedMaxPrice: token.observedMaxPrice,
            observedMinPrice: token.observedMinPrice,
            dynamicTrailingStopPercent,
            dynamicTargetProfitPercent,
            volatility
        };

        storage.saveActivePosition(this.currentPosition);

        console.log(chalk.green.bold(`\n[BUY] Mengunci target: ${this.currentPosition.symbol}`));
        console.log(chalk.gray(`Quoted Entry: $${quotedPrice}`));
        console.log(chalk.gray(`Executed Entry: $${this.currentPosition.entryPrice} | Fee: ${buyExecution.feeSol.toFixed(6)} SOL | Slip: ${buyExecution.slippageBps} bps`));

        await telegram.notifyTrade('BUY', {
            symbol: this.currentPosition.symbol,
            price: this.currentPosition.entryPrice,
            quotedPrice,
            address: this.currentPosition.address,
            feeSol: buyExecution.feeSol,
            slippageBps: buyExecution.slippageBps
        });

        this.startMonitoring();
    }

    startMonitoring() {
        console.log(chalk.blue(`Memulai monitoring via polling setiap 1 detik untuk ${this.currentPosition.symbol}...`));
        this.fallbackToPolling();
    }

    fallbackToPolling() {
        if (this.checkInterval || !this.currentPosition) return;

        console.log(chalk.yellow('Mengaktifkan polling setiap 1 detik...'));
        
        this.checkInterval = setInterval(async () => {
            try {
                if (!this.currentPosition) {
                    this.stopMonitoring();
                    return;
                }

                const currentPrice = await this.getCurrentPrice(this.currentPosition.pairAddress);
                if (!currentPrice) {
                    console.log(chalk.red("Gagal mendapatkan harga terbaru, mencoba lagi..."));
                    return;
                }

                const pnl = ((currentPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice) * 100;

                if (currentPrice > this.currentPosition.maxPrice) {
                    this.currentPosition.maxPrice = currentPrice;
                    this.currentPosition.maxPriceUpdatedAt = new Date().toISOString();
                    storage.saveActivePosition(this.currentPosition);
                }

                const maxPnl = ((this.currentPosition.maxPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice) * 100;
                process.stdout.write(chalk.white(`\rMonitoring ${this.currentPosition.symbol}: PNL ${pnl.toFixed(2)}% | Max ${maxPnl.toFixed(2)}% | SellFails ${this.currentPosition.failedSellAttempts || 0}    `));

                this.checkExitConditions(currentPrice, pnl, maxPnl);
            } catch (error) {
                console.error(chalk.red("\nError Monitoring:"), error.message);
            }
        }, 1000);
    }

    stopMonitoring() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    checkExitConditions(currentPrice, pnl, maxPnl) {
        const c = config.trading;
        const targetProfitPercent = this.currentPosition.dynamicTargetProfitPercent || c.targetProfitPercent;
        const trailingStopPercent = this.currentPosition.dynamicTrailingStopPercent || c.trailingStopPercent;
        const trailingStartPercent = c.trailingStartPercent;

        if (pnl >= targetProfitPercent) {
            this.closePosition(currentPrice, pnl, `🚀 Moon Target Reached (${targetProfitPercent}%)`);
            return;
        }

        if (maxPnl >= 6 && pnl < 6) {
            this.closePosition(currentPrice, pnl, `🔒 Profit Lock: Turun di bawah 6% (Locked ${pnl.toFixed(2)}%)`);
            return;
        }

        if (pnl >= trailingStartPercent) {
            const trailThreshold = this.currentPosition.maxPrice * (1 - (trailingStopPercent / 100));
            if (currentPrice <= trailThreshold) {
                this.closePosition(currentPrice, pnl, `🛡️ Trailing Stop: Locked at ${pnl.toFixed(2)}% (Dynamic ${trailingStopPercent}%)`);
                return;
            }
        }

        if (pnl <= -c.stopLossPercent) {
            this.closePosition(currentPrice, pnl, "❌ Stop Loss Terkena");
            return;
        }

        const timeElapsed = (Date.now() - new Date(this.currentPosition.openedAt).getTime()) / (60 * 1000);
        if (timeElapsed >= c.timeLimitMinutes) {
            this.closePosition(currentPrice, pnl, "⌛ Time Limit: No Significant Movement");
        }
    }

    async closePosition(price, pnl, reason) {
        this.stopMonitoring();
        const cRisk = config.riskManagement;
        const tokenAddress = this.currentPosition.address;
        const sellExecution = this.simulateSellExecution(price, this.currentPosition, reason);

        if (!sellExecution.ok) {
            this.currentPosition.failedSellAttempts = Number(this.currentPosition.failedSellAttempts || 0) + 1;
            this.currentPosition.lastSellFailureAt = new Date().toISOString();
            this.currentPosition.lastSellFailureReason = sellExecution.failureReason;
            this.currentPosition.accumulatedFailedSellFeesSol = Number(this.currentPosition.accumulatedFailedSellFeesSol || 0) + sellExecution.feeSol;
            storage.saveActivePosition(this.currentPosition);
            activityLogger.log('PAPER_SELL_FAILED', { symbol: this.currentPosition.symbol, address: tokenAddress, attempts: this.currentPosition.failedSellAttempts, ...sellExecution });
            console.log(chalk.red.bold(`\n[SELL FAILED] ${this.currentPosition.symbol}: ${sellExecution.failureReason}`));
            console.log(chalk.gray(`Attempt: ${this.currentPosition.failedSellAttempts}/${this.getPaperExecutionConfig().maxSellFailureRetries} | Fee lost: ${sellExecution.feeSol.toFixed(6)} SOL`));
            await telegram.sendMessage(`🟠 *PAPER SELL FAILED*\nToken: ${this.currentPosition.symbol}\nReason: ${sellExecution.failureReason}\nAttempt: ${this.currentPosition.failedSellAttempts}/${this.getPaperExecutionConfig().maxSellFailureRetries}\nFee Lost: ${sellExecution.feeSol.toFixed(6)} SOL`);
            this.startMonitoring();
            return;
        }

        const accumulatedFailedSellFeesSol = Number(this.currentPosition.accumulatedFailedSellFeesSol || 0);
        sellExecution.netPnlSol -= accumulatedFailedSellFeesSol;
        sellExecution.netPnlPercent = (sellExecution.netPnlSol / this.currentPosition.positionSize) * 100;

        const tradeData = {
            ...this.currentPosition,
            quotedExitPrice: price,
            exitPrice: sellExecution.executionPrice,
            pnl: sellExecution.netPnlPercent,
            grossMarketPnlPercent: pnl,
            netPnlSol: sellExecution.netPnlSol,
            grossReturnSol: sellExecution.grossReturnSol,
            netReturnSol: sellExecution.netReturnSol,
            sellFeeSol: sellExecution.feeSol,
            totalFeeSol: Number(this.currentPosition.buyFeeSol || 0) + sellExecution.feeSol + accumulatedFailedSellFeesSol,
            accumulatedFailedSellFeesSol,
            sellSlippageBps: sellExecution.slippageBps,
            reason,
            closedAt: new Date().toISOString()
        };

        try {
            storage.saveTrade(tradeData);

            let state = storage.getState();
            if (!state.tokenStats[tokenAddress]) {
                state.tokenStats[tokenAddress] = { slCount: 0, cooldownUntil: 0, blacklisted: false };
            }
            let tState = state.tokenStats[tokenAddress];
            let alertMsg = "";

            if (tradeData.netPnlSol < 0) {
                state.consecutiveLosses += 1;
                tState.slCount += 1;

                if (tradeData.pnl <= cRisk.rugpullThresholdPercent) {
                    tState.blacklisted = true;
                    alertMsg = `🚨 *RUGPULL DETECTED* (${tradeData.pnl.toFixed(2)}%). Koin di-blacklist permanen!`;
                } else if (tState.slCount >= 2) {
                    tState.cooldownUntil = Date.now() + (cRisk.slCooldown2xMinutes * 60 * 1000);
                    alertMsg = `⏸️ *Kena SL 2x*. Blacklist koin ini ${cRisk.slCooldown2xMinutes} menit.`;
                } else {
                    tState.cooldownUntil = Date.now() + (cRisk.slCooldown1xMinutes * 60 * 1000);
                    alertMsg = `⏳ *Kena SL 1x*. Koin di-cooldown ${cRisk.slCooldown1xMinutes} menit.`;
                }

                if (state.consecutiveLosses >= cRisk.maxConsecutiveLosses) {
                    state.globalPauseUntil = Date.now() + (cRisk.globalPauseMinutes * 60 * 1000);
                    state.consecutiveLosses = 0;
                    await telegram.sendMessage(`🛑 *GLOBAL PAUSE DIAKTIFKAN*\nBot mengalami loss ${cRisk.maxConsecutiveLosses}x berturut-turut. Scanner dihentikan selama ${cRisk.globalPauseMinutes} menit untuk menghindari kondisi pasar yang buruk.`);
                }
            } else {
                state.consecutiveLosses = 0;
                tState.cooldownUntil = Date.now() + (5 * 60 * 1000);
            }

            storage.saveState(state);
            await telegram.notifyTrade('SELL', tradeData);
            if (alertMsg !== "") await telegram.sendMessage(alertMsg);
        } catch (error) {
            console.error("Gagal menutup posisi:", error.message);
        } finally {
            this.currentPosition = null;
            this.hasRecovered = false;
        }
    }
}

module.exports = new EngineService();