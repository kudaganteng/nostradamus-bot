const axios = require('axios');
const chalk = require('chalk');
const config = require('../../config.json');
const telegram = require('./telegram');
const storage = require('../utils/storage');
const activityLogger = require('../utils/activityLogger');
const jupiter = require('./jupiter');
const { Connection, PublicKey } = require('@solana/web3.js');

class EngineService {
    constructor() {
        storage.init();
        this.connection = new Connection(config.rpc.alchemyUrl, 'confirmed');
        this.checkInterval = null;
        this.pairEndpoint = 'https://api.dexscreener.com/latest/dex/pairs/solana/';
        this.hasRecovered = false;
        this.isClosing = false;

        this.currentPosition = storage.loadActivePosition();

        if (this.currentPosition) {
            console.log(chalk.yellow.bold('\n[RECOVERY] Melanjutkan monitoring posisi yang terbuka...'));
            this.startMonitoring();
            this.hasRecovered = true;
        } else {
            this.currentPosition = null;
        }
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

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    getExecutionConfig() {
        return {
            simulateLatency: config.execution?.simulateLatency ?? true,
            minLatencyMs: config.execution?.minLatencyMs ?? 1000,
            maxLatencyMs: config.execution?.maxLatencyMs ?? 3000,
            requoteAfterLatency: config.execution?.requoteAfterLatency ?? true,
            rejectIfQuoteWorsensPct: config.execution?.rejectIfQuoteWorsensPct ?? 5
        };
    }

    getMonitoringConfig() {
        return {
            quoteRefreshMs: config.monitoring?.quoteRefreshMs ?? 5000
        };
    }

    getRandomLatencyMs() {
        const exec = this.getExecutionConfig();
        const min = Math.max(0, Number(exec.minLatencyMs));
        const max = Math.max(min, Number(exec.maxLatencyMs));
        return Math.floor(min + Math.random() * (max - min + 1));
    }

    async simulateLatency(side, symbol) {
        const exec = this.getExecutionConfig();
        if (!exec.simulateLatency) {
            return { simulated: false, latencyMs: 0 };
        }

        const latencyMs = this.getRandomLatencyMs();
        console.log(chalk.gray(`[Latency ${side}] Simulasi delay eksekusi ${latencyMs}ms untuk ${symbol}...`));
        await this.delay(latencyMs);
        return { simulated: true, latencyMs };
    }

    getBuyQuoteWorseningPct(initialExecution, finalExecution) {
        if (!initialExecution?.entryPriceUsd || !finalExecution?.entryPriceUsd) return 0;
        return ((finalExecution.entryPriceUsd - initialExecution.entryPriceUsd) / initialExecution.entryPriceUsd) * 100;
    }

    getSellQuoteWorseningPct(initialExecution, finalExecution) {
        if (!initialExecution?.exitSolAmount || !finalExecution?.exitSolAmount) return 0;
        return ((initialExecution.exitSolAmount - finalExecution.exitSolAmount) / initialExecution.exitSolAmount) * 100;
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

    async getIndicativePriceFromJupiterQuote() {
        if (!this.currentPosition?.tokenAmountRaw || !this.currentPosition?.tokenDecimals) {
            throw new Error('Data posisi tidak lengkap untuk refresh quote Jupiter.');
        }

        const quote = await jupiter.getSellExecution(
            this.currentPosition.address,
            this.currentPosition.tokenAmountRaw,
            this.currentPosition.tokenDecimals
        );

        return {
            price: quote.exitPriceUsd,
            exitSolAmount: quote.exitSolAmount,
            priceImpactPct: quote.priceImpactPct,
            quote
        };
    }

    async checkWalletMonopoly(tokenAddress) {
        try {
            console.log(chalk.cyan(`\\n[Monopoly Check] 🔍 Menganalisis distribusi wallet untuk ${tokenAddress}...`));

            const response = await axios.post(config.rpc.alchemyUrl, {
                jsonrpc: '2.0',
                id: 1,
                method: 'getTokenLargestAccounts',
                params: [tokenAddress]
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 5000
            });

            if (!response.data || !response.data.result || !response.data.result.value) {
                console.log(chalk.yellow('[Monopoly Check] ⚠️ Gagal mendapatkan data wallet terbesar.'));
                return false;
            }

            const topHolders = response.data.result.value.slice(0, 10);
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
            const response = await axios.get(geckoUrl, {
                headers: { Accept: 'application/json' },
                timeout: 8000
            });

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
            const avgTransactionValue = totalBuyTransactions > 0 ? totalVolumeUsd / totalBuyTransactions : 0;
            const transactionsPerBuyer = uniqueBuyersCount > 0 ? totalBuyTransactions / uniqueBuyersCount : 0;

            console.log(chalk.gray(`   Total Transaksi Beli (5m): ${totalBuyTransactions}`));
            console.log(chalk.gray(`   Unique Buyers (5m): ${uniqueBuyersCount}`));
            console.log(chalk.gray(`   Total Volume: $${totalVolumeUsd.toFixed(2)}`));
            console.log(chalk.gray(`   Rata-rata per Transaksi: $${avgTransactionValue.toFixed(2)}`));
            console.log(chalk.gray(`   Transaksi per Buyer: ${transactionsPerBuyer.toFixed(1)}`));

            if (avgTransactionValue < 2 && totalBuyTransactions > 5) {
                console.log(chalk.red.bold(`   ⚠️ WASH TRADING DETECTED: Rata-rata transaksi hanya $${avgTransactionValue.toFixed(2)} (Fake Volume!)`));
                activityLogger.log('WASH_TRADING_DETECTED', {
                    token: tokenAddress,
                    reason: 'low_avg_transaction',
                    avgTransactionValue: avgTransactionValue.toFixed(2),
                    totalVolume: totalVolumeUsd.toFixed(2),
                    totalTransactions: totalBuyTransactions,
                    uniqueBuyers: uniqueBuyersCount
                });
                return true;
            }

            if (transactionsPerBuyer > 20 && totalBuyTransactions > 10) {
                console.log(chalk.red.bold(`   ⚠️ WASH TRADING DETECTED: ${transactionsPerBuyer.toFixed(1)} transaksi per buyer (Bot Activity!)`));
                activityLogger.log('WASH_TRADING_DETECTED', {
                    token: tokenAddress,
                    reason: 'high_transactions_per_buyer',
                    transactionsPerBuyer: transactionsPerBuyer.toFixed(1),
                    totalTransactions: totalBuyTransactions,
                    uniqueBuyers: uniqueBuyersCount
                });
                return true;
            }

            const buyerRatio = totalBuyTransactions > 0 ? uniqueBuyersCount / totalBuyTransactions : 0;
            if (buyerRatio < 0.1 && totalBuyTransactions > 10) {
                console.log(chalk.red.bold(`   ⚠️ WASH TRADING DETECTED: Hanya ${uniqueBuyersCount} unique buyers dari ${totalBuyTransactions} transaksi!`));
                activityLogger.log('WASH_TRADING_DETECTED', {
                    token: tokenAddress,
                    reason: 'low_unique_buyer_ratio',
                    buyerRatio: buyerRatio.toFixed(3),
                    totalTransactions: totalBuyTransactions,
                    uniqueBuyers: uniqueBuyersCount
                });
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
        activityLogger.log('OBSERVATION_START', { symbol: token.baseToken.symbol });
        const obs = config.observation;
        console.log(chalk.cyan(`\n[Observer] 🕵️ Menunda Entry. Mengawasi ${token.baseToken.symbol} selama ${obs.durationSeconds} detik...`));

        const prices = [];
        const realTimeInterval = 1;
        const iterations = Math.floor(obs.durationSeconds / realTimeInterval);

        for (let i = 0; i < iterations; i++) {
            const currentPrice = await this.getCurrentPrice(token.pairAddress, true);
            if (currentPrice) prices.push(currentPrice);
            process.stdout.write(chalk.gray(`> Merekam aksi harga: ${prices.length}/${iterations} detik...\r`));
            await new Promise(resolve => setTimeout(resolve, realTimeInterval * 1000));
        }

        if (prices.length < 3) {
            console.log(chalk.yellow('\n[Observer] ❌ Ditolak: Data harga tidak cukup stabil dari RPC.'));
            return false;
        }

        const isMonopolized = await this.checkWalletMonopoly(token.baseToken.address);
        if (isMonopolized) {
            console.log(chalk.yellow('\n[Observer] ❌ Ditolak: Terdeteksi monopoli wallet pada token ini.'));
            return false;
        }

        const isWashTrading = await this.checkWashTrading(token.baseToken.address, token.pairAddress);
        if (isWashTrading) {
            console.log(chalk.yellow('\n[Observer] ❌ Ditolak: Terdeteksi Wash Trading / Bot Activity pada token ini.'));
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
            priceChanges.push(((prices[i] - prices[i - 1]) / prices[i - 1]) * 100);
        }
        const meanChange = priceChanges.reduce((a, b) => a + b, 0) / priceChanges.length;
        const variance = priceChanges.reduce((a, b) => a + Math.pow(b - meanChange, 2), 0) / priceChanges.length;
        const volatility = Math.sqrt(variance);

        token.volatility = volatility;
        token.priceRange = maxDropPercent;

        console.log(chalk.green.bold('\n[Observer] ✅ TERKONFIRMASI! Trend positif terdeteksi. Mengeksekusi BUY via Jupiter quote!'));
        console.log(chalk.gray(`   Start: $${startPrice.toFixed(6)} | End: $${endPrice.toFixed(6)} | Range: ${maxDropPercent.toFixed(2)}%`));
        console.log(chalk.gray(`   Volatility (StdDev): ${volatility.toFixed(4)}% per detik`));
        return true;
    }

    async openPosition(token) {
        if (this.currentPosition) {
            console.log(chalk.yellow('Percobaan membuka posisi ditolak: Masih ada trade yang berjalan.'));
            return;
        }

        const tokenDecimals = token.baseToken.decimals || token.info?.decimals || config.trading.defaultTokenDecimals || 6;
        const execConfig = this.getExecutionConfig();
        let initialBuyExecution;
        let buyExecution;
        let latencyInfo = { simulated: false, latencyMs: 0 };
        let quoteWorseningPct = 0;

        try {
            console.log(chalk.cyan(`\n[Jupiter BUY] Mengambil quote awal untuk ${token.baseToken.symbol}...`));
            initialBuyExecution = await jupiter.getBuyExecution(token.baseToken.address, config.trading.positionSize, tokenDecimals);

            latencyInfo = await this.simulateLatency('BUY', token.baseToken.symbol);

            if (execConfig.requoteAfterLatency) {
                console.log(chalk.cyan(`[Jupiter BUY] Requote setelah latency untuk ${token.baseToken.symbol}...`));
                buyExecution = await jupiter.getBuyExecution(token.baseToken.address, config.trading.positionSize, tokenDecimals);
                quoteWorseningPct = this.getBuyQuoteWorseningPct(initialBuyExecution, buyExecution);

                if (quoteWorseningPct > execConfig.rejectIfQuoteWorsensPct) {
                    throw new Error(`Quote BUY memburuk ${quoteWorseningPct.toFixed(2)}% setelah latency, batas ${execConfig.rejectIfQuoteWorsensPct}%`);
                }
            } else {
                buyExecution = initialBuyExecution;
            }
        } catch (error) {
            console.log(chalk.red(`[Jupiter BUY] Entry ditolak: ${error.message}`));
            activityLogger.log('JUPITER_BUY_QUOTE_FAILED', {
                symbol: token.baseToken.symbol,
                address: token.baseToken.address,
                error: error.message,
                latencyInfo,
                quoteWorseningPct
            });
            return;
        }

        const price = buyExecution.entryPriceUsd;
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
        console.log(chalk.cyan(`[Jupiter BUY] Entry Final: $${price.toFixed(12)} | Price Impact: ${buyExecution.priceImpactPct}% | Posisi: ${buyExecution.executedPositionSizeSol} SOL | Est. Fee: ${buyExecution.estimatedFeeSol} SOL`));
        if (latencyInfo.simulated) {
            console.log(chalk.gray(`[Latency BUY] Quote worsening setelah latency: ${quoteWorseningPct.toFixed(2)}%`));
        }

        this.currentPosition = {
            symbol: token.baseToken.symbol,
            address: token.baseToken.address,
            pairAddress: token.pairAddress,
            tokenDecimals,
            entrySource: buyExecution.source,
            entryPrice: price,
            maxPrice: price,
            positionSize: buyExecution.executedPositionSizeSol,
            requestedPositionSize: config.trading.positionSize,
            tokenAmount: buyExecution.tokenAmount,
            tokenAmountRaw: buyExecution.tokenOutRaw,
            entrySolValue: buyExecution.executedPositionSizeSol,
            entryUsdValue: buyExecution.solUsdValue,
            entryPriceImpactPct: buyExecution.priceImpactPct,
            entryEstimatedFeeSol: buyExecution.estimatedFeeSol,
            totalEstimatedFeesSol: buyExecution.estimatedFeeSol,
            buyLatencyMs: latencyInfo.latencyMs,
            buyQuoteWorseningPct: quoteWorseningPct,
            buyQuoteAttempts: buyExecution.quoteAttempts,
            openedAt: new Date().toISOString(),
            dynamicTrailingStopPercent,
            dynamicTargetProfitPercent,
            volatility
        };

        storage.saveActivePosition(this.currentPosition);

        console.log(chalk.green.bold(`\n[BUY] Mengunci target: ${this.currentPosition.symbol}`));
        console.log(chalk.gray(`Entry Price Jupiter: $${this.currentPosition.entryPrice}`));
        console.log(chalk.gray(`Token Amount: ${this.currentPosition.tokenAmount}`));

        await telegram.notifyTrade('BUY', {
            symbol: this.currentPosition.symbol,
            price: this.currentPosition.entryPrice,
            address: this.currentPosition.address
        });

        this.startMonitoring();
    }

    startMonitoring() {
        const refreshMs = this.getMonitoringConfig().quoteRefreshMs;
        console.log(chalk.blue(`Memulai monitoring via Jupiter quote setiap ${refreshMs / 1000} detik untuk ${this.currentPosition.symbol}...`));
        this.fallbackToPolling();
    }

    fallbackToPolling() {
        if (this.checkInterval || !this.currentPosition) return;

        const refreshMs = this.getMonitoringConfig().quoteRefreshMs;
        console.log(chalk.yellow(`Mengaktifkan refresh quote Jupiter setiap ${refreshMs / 1000} detik...`));

        this.checkInterval = setInterval(async () => {
            try {
                if (!this.currentPosition) {
                    this.stopMonitoring();
                    return;
                }

                const quoteSnapshot = await this.getIndicativePriceFromJupiterQuote();
                const currentPrice = quoteSnapshot.price;

                if (!currentPrice) {
                    console.log(chalk.red('Gagal mendapatkan harga quote Jupiter terbaru, mencoba lagi...'));
                    return;
                }

                const pnl = ((currentPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice) * 100;

                if (currentPrice > this.currentPosition.maxPrice) {
                    this.currentPosition.maxPrice = currentPrice;
                }

                const maxPnl = ((this.currentPosition.maxPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice) * 100;
                process.stdout.write(chalk.white(`\rMonitoring ${this.currentPosition.symbol}: Jupiter Quote PNL ${pnl.toFixed(2)}% | Max ${maxPnl.toFixed(2)}% | Impact ${quoteSnapshot.priceImpactPct}%    `));

                this.checkExitConditions(currentPrice, pnl, maxPnl);
            } catch (error) {
                console.error(chalk.red('\nError refresh quote Jupiter:'), error.message);
            }
        }, refreshMs);
    }

    stopMonitoring() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    checkExitConditions(currentPrice, pnl, maxPnl) {
        if (this.isClosing) return;

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
            const trailThreshold = this.currentPosition.maxPrice * (1 - trailingStopPercent / 100);
            if (currentPrice <= trailThreshold) {
                this.closePosition(currentPrice, pnl, `🛡️ Trailing Stop: Locked at ${pnl.toFixed(2)}% (Dynamic ${trailingStopPercent}%)`);
                return;
            }
        }

        if (pnl <= -c.stopLossPercent) {
            this.closePosition(currentPrice, pnl, '❌ Stop Loss Terkena');
            return;
        }

        const timeElapsed = (Date.now() - new Date(this.currentPosition.openedAt).getTime()) / (60 * 1000);
        if (timeElapsed >= c.timeLimitMinutes) {
            this.closePosition(currentPrice, pnl, '⌛ Time Limit: No Significant Movement');
        }
    }

    async closePosition(indicativePrice, indicativePnl, reason) {
        if (this.isClosing || !this.currentPosition) return;
        this.isClosing = true;
        this.stopMonitoring();

        const cRisk = config.riskManagement;
        const tokenAddress = this.currentPosition.address;
        const execConfig = this.getExecutionConfig();
        let initialSellExecution;
        let sellExecution;
        let latencyInfo = { simulated: false, latencyMs: 0 };
        let quoteWorseningPct = 0;

        try {
            console.log(chalk.cyan(`\n[Jupiter SELL] Mengambil quote awal exit untuk ${this.currentPosition.symbol}...`));
            initialSellExecution = await jupiter.getSellExecution(
                this.currentPosition.address,
                this.currentPosition.tokenAmountRaw,
                this.currentPosition.tokenDecimals
            );

            latencyInfo = await this.simulateLatency('SELL', this.currentPosition.symbol);

            if (execConfig.requoteAfterLatency) {
                console.log(chalk.cyan(`[Jupiter SELL] Requote setelah latency untuk ${this.currentPosition.symbol}...`));
                sellExecution = await jupiter.getSellExecution(
                    this.currentPosition.address,
                    this.currentPosition.tokenAmountRaw,
                    this.currentPosition.tokenDecimals
                );
                quoteWorseningPct = this.getSellQuoteWorseningPct(initialSellExecution, sellExecution);
            } else {
                sellExecution = initialSellExecution;
            }
        } catch (error) {
            console.log(chalk.red(`[Jupiter SELL] Gagal mengambil quote exit: ${error.message}`));
            activityLogger.log('JUPITER_SELL_QUOTE_FAILED', {
                symbol: this.currentPosition.symbol,
                address: this.currentPosition.address,
                error: error.message,
                latencyInfo,
                quoteWorseningPct
            });
            this.startMonitoring();
            this.isClosing = false;
            return;
        }

        const grossProfitSol = sellExecution.exitSolAmount - this.currentPosition.entrySolValue;
        const totalEstimatedFeesSol = (this.currentPosition.entryEstimatedFeeSol || 0) + sellExecution.estimatedFeeSol;
        const netProfitSol = grossProfitSol - totalEstimatedFeesSol;
        const grossPnl = (grossProfitSol / this.currentPosition.entrySolValue) * 100;
        const netPnl = (netProfitSol / this.currentPosition.entrySolValue) * 100;

        const tradeData = {
            ...this.currentPosition,
            exitSource: sellExecution.source,
            exitPrice: sellExecution.exitPriceUsd,
            indicativeExitPrice: indicativePrice,
            indicativePnl,
            grossPnl,
            pnl: netPnl,
            grossProfitSol,
            netProfitSol,
            exitSolAmount: sellExecution.exitSolAmount,
            exitUsdValue: sellExecution.exitUsdValue,
            exitPriceImpactPct: sellExecution.priceImpactPct,
            exitEstimatedFeeSol: sellExecution.estimatedFeeSol,
            totalEstimatedFeesSol,
            sellLatencyMs: latencyInfo.latencyMs,
            sellQuoteWorseningPct: quoteWorseningPct,
            initialExitSolAmount: initialSellExecution?.exitSolAmount,
            finalExitSolAmount: sellExecution.exitSolAmount,
            reason,
            closedAt: new Date().toISOString()
        };

        try {
            storage.saveTrade(tradeData);

            let state = storage.getState();
            if (!state.tokenStats[tokenAddress]) {
                state.tokenStats[tokenAddress] = { slCount: 0, cooldownUntil: 0, blacklisted: false };
            }
            const tState = state.tokenStats[tokenAddress];
            let alertMsg = '';

            if (netPnl < 0) {
                state.consecutiveLosses += 1;
                tState.slCount += 1;

                if (netPnl <= cRisk.rugpullThresholdPercent) {
                    tState.blacklisted = true;
                    alertMsg = `🚨 *RUGPULL DETECTED* (${netPnl.toFixed(2)}%). Koin di-blacklist permanen!`;
                } else if (tState.slCount >= 2) {
                    tState.cooldownUntil = Date.now() + cRisk.slCooldown2xMinutes * 60 * 1000;
                    alertMsg = `⏸️ *Kena SL 2x*. Blacklist koin ini ${cRisk.slCooldown2xMinutes} menit.`;
                } else {
                    tState.cooldownUntil = Date.now() + cRisk.slCooldown1xMinutes * 60 * 1000;
                    alertMsg = `⏳ *Kena SL 1x*. Koin di-cooldown ${cRisk.slCooldown1xMinutes} menit.`;
                }

                if (state.consecutiveLosses >= cRisk.maxConsecutiveLosses) {
                    state.globalPauseUntil = Date.now() + cRisk.globalPauseMinutes * 60 * 1000;
                    state.consecutiveLosses = 0;
                    await telegram.sendMessage(`🛑 *GLOBAL PAUSE DIAKTIFKAN*\nBot mengalami loss ${cRisk.maxConsecutiveLosses}x berturut-turut. Scanner dihentikan selama ${cRisk.globalPauseMinutes} menit untuk menghindari kondisi pasar yang buruk.`);
                }
            } else {
                state.consecutiveLosses = 0;
                tState.cooldownUntil = Date.now() + 5 * 60 * 1000;
            }

            storage.saveState(state);

            console.log(chalk.green.bold(`\n[SELL] ${this.currentPosition.symbol} ditutup via Jupiter quote final setelah latency.`));
            console.log(chalk.gray(`Gross PNL: ${grossPnl.toFixed(2)}% | Net PNL after fees: ${netPnl.toFixed(2)}%`));
            console.log(chalk.gray(`Estimated Fees: ${totalEstimatedFeesSol} SOL | Sell quote worsening: ${quoteWorseningPct.toFixed(2)}%`));

            await telegram.notifyTrade('SELL', tradeData);
            if (alertMsg !== '') await telegram.sendMessage(alertMsg);
        } catch (error) {
            console.error('Gagal menutup posisi:', error.message);
        } finally {
            this.currentPosition = null;
            this.hasRecovered = false;
            this.isClosing = false;
        }
    }
}

module.exports = new EngineService();
