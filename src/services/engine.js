const axios = require('axios');
const chalk = require('chalk');
const config = require('../../config.json');
const telegram = require('./telegram');
const storage = require('../utils/storage');
const scanner = require('./scanner');
const activityLogger = require('../utils/activityLogger');
const { Connection, PublicKey } = require('@solana/web3.js');

class EngineService {
    constructor() {
        // Inisialisasi storage saat engine dinyalakan
        storage.init();
        this.connection = new Connection(config.rpc.alchemyUrl, 'confirmed');
        this.checkInterval = null;
        this.pairEndpoint = 'https://api.dexscreener.com/latest/dex/pairs/solana/';
        this.hasRecovered = false; // Flag untuk mencegah recovery berulang
        
        // Coba load posisi aktif yang tersimpan dari sesi sebelumnya (recovery)
        // HANYA DILAKUKAN SEKALI SAAT BOT DINYALAKAN
        this.currentPosition = storage.loadActivePosition();
        
        // Jika ada posisi yang sedang berjalan, lanjutkan monitoring
        if (this.currentPosition) {
            console.log(chalk.yellow.bold('\n[RECOVERY] Melanjutkan monitoring posisi yang terbuka...'));
            this.startMonitoring();
            this.hasRecovered = true; // Tandai bahwa recovery sudah dilakukan
        } else {
            this.currentPosition = null;
        }
    }
    
    /**
     * Recovery posisi aktif dari sesi sebelumnya - HANYA DIPANGGIL SEKALI DI AWAL
     */
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

    /**
     * Mengecek apakah ada wallet yang memonopoli supply token
     * Menggunakan Alchemy RPC getTokenLargestAccounts
     */
    async checkWalletMonopoly(tokenAddress) {
        try {
            console.log(chalk.cyan(`\\n[Monopoly Check] 🔍 Menganalisis distribusi wallet untuk ${tokenAddress}...`));
            
            const response = await axios.post(config.rpc.alchemyUrl, {
                jsonrpc: "2.0",
                id: 1,
                method: "getTokenLargestAccounts",
                params: [tokenAddress]
            }, {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 5000
            });

            if (!response.data || !response.data.result || !response.data.result.value) {
                console.log(chalk.yellow('[Monopoly Check] ⚠️ Gagal mendapatkan data wallet terbesar.'));
                return false; // Gagal cek, anggap aman agar tidak reject false positive
            }

            const largestAccounts = response.data.result.value;
            
            // Filter out mint authority dan program accounts jika ada
            const topHolders = largestAccounts.slice(0, 10); // Ambil 10 teratas
            
            let totalSupply = 0;
            let topHolderAmount = 0;
            
            topHolders.forEach(account => {
                const amount = parseFloat(account.amount);
                totalSupply += amount;
                if (topHolders.indexOf(account) === 0) {
                    topHolderAmount = amount;
                }
            });

            // Hitung persentase kepemilikan wallet terbesar
            const monopolyPercent = (topHolderAmount / totalSupply) * 100;
            
            console.log(chalk.gray(`   Top 10 holders: ${totalSupply.toFixed(0)} tokens`));
            console.log(chalk.gray(`   Wallet #1 memegang: ${topHolderAmount.toFixed(0)} tokens (${monopolyPercent.toFixed(2)}%)`));

            // Jika wallet terbesar memegang lebih dari 30% dari top 10 holders, anggap monopoli
            const MONOPOLY_THRESHOLD = 70;
            
            if (monopolyPercent > MONOPOLY_THRESHOLD) {
                console.log(chalk.red.bold(`   ⚠️ WARNING: Wallet terbesar mengontrol ${monopolyPercent.toFixed(2)}% supply!`));
                activityLogger.log('MONOPOLY_DETECTED', { 
                    token: tokenAddress, 
                    monopolyPercent: monopolyPercent.toFixed(2) 
                });
                return true;
            }

            console.log(chalk.green(`   ✅ Distribusi wallet sehat (${monopolyPercent.toFixed(2)}%)`));
            return false;

        } catch (error) {
            console.log(chalk.yellow(`[Monopoly Check] ⚠️ Error mengecek wallet: ${error.message}`));
            activityLogger.log('MONOPOLY_CHECK_ERROR', { 
                token: tokenAddress, 
                error: error.message 
            });
            // Jika error, anggap aman (false) agar tidak reject token karena error teknis
            return false;
        }
    }

    /**
     * Mengecek Wash Trading menggunakan Gecko Terminal API
     * Kriteria:
     * 1. Rata-rata transaksi < $2 = 100% fake volume (bot)
     * 2. Unique Buyers terlalu sedikit dibanding total transaksi beli (misal: 100 transaksi tapi cuma 2 unique buyers)
     */
    async checkWashTrading(tokenAddress, pairAddress) {
        try {
            console.log(chalk.cyan(`\\n[Wash Trading Check] 🔍 Menganalisis aktivitas trading untuk ${tokenAddress}...`));
            
            // Gunakan Gecko Terminal API untuk mendapatkan data pool dan transaksi
            // Endpoint: https://api.geckoterminal.com/api/v2/networks/solana/pools/{pool_address}
            const geckoUrl = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}`;
            
            const response = await axios.get(geckoUrl, {
                headers: {
                    'Accept': 'application/json'
                },
                timeout: 8000
            });

            if (!response.data || !response.data.data) {
                console.log(chalk.yellow('[Wash Trading Check] ⚠️ Tidak ada data pool dari Gecko Terminal.'));
                return false; // Gagal cek, anggap aman
            }

            const poolData = response.data.data;
            const attributes = poolData.attributes || {};
            
            // Ambil data transaksi dari relationships jika tersedia, atau gunakan data pool
            const txCount = attributes.txns ? attributes.txns.m5.buys : 0;
            const volumeUsd = attributes.volume_usd || 0;
            const uniqueBuyersM5 = attributes.unique_buyers_m5 || 0;
            
            // Jika tidak ada data transaksi 5 menit, coba ambil dari field lain
            const totalBuyTransactions = txCount > 0 ? txCount : (attributes.transactions_5m || 0);
            const totalVolumeUsd = parseFloat(volumeUsd) || 0;
            const uniqueBuyersCount = uniqueBuyersM5 > 0 ? uniqueBuyersM5 : (attributes.unique_traders_m5 || 0);

            // Hitung rata-rata nilai per transaksi
            const avgTransactionValue = totalBuyTransactions > 0 ? (totalVolumeUsd / totalBuyTransactions) : 0;
            
            // Hitung rasio transaksi per unique buyer
            const transactionsPerBuyer = uniqueBuyersCount > 0 ? (totalBuyTransactions / uniqueBuyersCount) : 0;

            console.log(chalk.gray(`   Total Transaksi Beli (5m): ${totalBuyTransactions}`));
            console.log(chalk.gray(`   Unique Buyers (5m): ${uniqueBuyersCount}`));
            console.log(chalk.gray(`   Total Volume: $${totalVolumeUsd.toFixed(2)}`));
            console.log(chalk.gray(`   Rata-rata per Transaksi: $${avgTransactionValue.toFixed(2)}`));
            console.log(chalk.gray(`   Transaksi per Buyer: ${transactionsPerBuyer.toFixed(1)}`));

            // --- KRITERIA WASH TRADING ---
            
            // 1. Rata-rata transaksi terlalu kecil (< $2) = indikasi bot/fake volume
            const MIN_AVG_TRANSACTION = 2; // Dollar
            if (avgTransactionValue < MIN_AVG_TRANSACTION && totalBuyTransactions > 5) {
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

            // 2. Terlalu banyak transaksi dari sedikit unique buyers
            // Contoh: 100 transaksi dari 2 wallet = 50 transaksi/wallet = pasti bot
            const MAX_TRANSACTIONS_PER_BUYER = 20; // Jika 1 wallet melakukan > 20 transaksi dalam periode singkat = suspicious
            
            if (transactionsPerBuyer > MAX_TRANSACTIONS_PER_BUYER && totalBuyTransactions > 10) {
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

            // 3. Cek rasio unique buyers terhadap total transaksi
            // Jika unique buyers < 10% dari total transaksi, sangat suspicious
            const buyerRatio = uniqueBuyersCount / totalBuyTransactions;
            const MIN_BUYER_RATIO = 0.1; // 10%
            
            if (buyerRatio < MIN_BUYER_RATIO && totalBuyTransactions > 10) {
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
            activityLogger.log('WASH_TRADING_CHECK_ERROR', { 
                token: tokenAddress, 
                error: error.message 
            });
            // Jika error, anggap aman (false) agar tidak reject token karena error teknis
            return false;
        }
    }

    async observeAndConfirm(token) {
        activityLogger.log("OBSERVATION_START", { symbol: token.baseToken.symbol });
        const obs = config.observation;
        console.log(chalk.cyan(`\n[Observer] 🕵️ Menunda Entry. Mengawasi ${token.baseToken.symbol} selama ${obs.durationSeconds} detik...`));

        let prices = [];
        // Ubah interval menjadi 1 detik untuk data lebih real-time selama observasi
        const realTimeInterval = 1; 
        const iterations = Math.floor(obs.durationSeconds / realTimeInterval);

        for (let i = 0; i < iterations; i++) {
            const currentPrice = await this.getCurrentPrice(token.pairAddress, true);
            if (currentPrice) prices.push(currentPrice);

            // Tampilkan indikator loading di terminal
            process.stdout.write(chalk.gray(`> Merekam aksi harga: ${prices.length}/${iterations} detik...\r`));

            await new Promise(resolve => setTimeout(resolve, realTimeInterval * 1000));
        }

        if (prices.length < 3) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Data harga tidak cukup stabil dari RPC.`));
            return false;
        }

        // --- FILTER DOMINASI WALLET (MONOPOLI CEK) ---
        const isMonopolized = await this.checkWalletMonopoly(token.baseToken.address);
        if (isMonopolized) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Terdeteksi monopoli wallet pada token ini.`));
            return false;
        }

        // --- FILTER WASH TRADING (BOT ACTIVITY CEK) ---
        const isWashTrading = await this.checkWashTrading(token.baseToken.address, token.pairAddress);
        if (isWashTrading) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Terdeteksi Wash Trading / Bot Activity pada token ini.`));
            return false;
        }

        // --- ANALISIS STRUKTUR PASAR (SIMPLIFIED) ---
        const startPrice = prices[0];
        const endPrice = prices[prices.length - 1];
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);

        // 1. Syarat Trend: Harga akhir harus lebih tinggi dari harga awal (uptrend dasar)
        // Longgarkan: boleh flat atau sedikit negatif asal tidak > -3%
        const trendPercent = ((endPrice - startPrice) / startPrice) * 100;
        if (trendPercent < -3) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Trend negatif (${trendPercent.toFixed(2)}%).`));
            return false;
        }

        // 2. Syarat Stabilitas: Tidak ada dump ekstrem (> maxDumpPercent)
        // Longgarkan dari 15% ke 25% agar tidak menolak token volatile
        const maxDropPercent = ((maxPrice - minPrice) / maxPrice) * 100;
        if (maxDropPercent > 25) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Volatilitas terlalu tinggi (${maxDropPercent.toFixed(2)}%).`));
            return false;
        }

        // 3. Syarat Entry: Harga tidak sedang di pucuk (allow some pullback)
        // Longgarkan dari 5% ke 10% untuk memberikan ruang entry lebih besar
        const fromPeakPercent = ((maxPrice - endPrice) / maxPrice) * 100;
        if (fromPeakPercent > 10) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Harga turun terlalu jauh dari puncak (${fromPeakPercent.toFixed(2)}%).`));
            return false;
        }

        console.log(chalk.green.bold(`\n[Observer] ✅ TERKONFIRMASI! Trend positif terdeteksi. Mengeksekusi BUY!`));
        console.log(chalk.gray(`   Start: $${startPrice.toFixed(6)} | End: $${endPrice.toFixed(6)} | Range: ${maxDropPercent.toFixed(2)}%`));
        return true;
    }

    /**
     * Membuka posisi baru (Paper Trade Buy)
     */
    async openPosition(token) {
        if (this.currentPosition) {
            console.log(chalk.yellow("Percobaan membuka posisi ditolak: Masih ada trade yang berjalan."));
            return;
        }

        const price = parseFloat(token.priceUsd);

        this.currentPosition = {
            symbol: token.baseToken.symbol,
            address: token.baseToken.address, // CA Token
            pairAddress: token.pairAddress,
            entryPrice: price,
            maxPrice: price, // Digunakan untuk kalkulasi Trailing Stop
            positionSize: config.trading.positionSize,
            openedAt: new Date().toISOString()
        };

        // Simpan posisi aktif ke file untuk recovery
        storage.saveActivePosition(this.currentPosition);

        console.log(chalk.green.bold(`\n[BUY] Mengunci target: ${this.currentPosition.symbol}`));
        console.log(chalk.gray(`Entry Price: $${this.currentPosition.entryPrice}`));

        // Kirim Notifikasi Telegram
        await telegram.notifyTrade('BUY', {
            symbol: this.currentPosition.symbol,
            price: this.currentPosition.entryPrice,
            address: this.currentPosition.address
        });

        // Jalankan monitoring harga secara intensif
        this.startMonitoring();
    }

    /**
     * Loop Monitoring Harga menggunakan Polling (1 detik)
     */
    startMonitoring() {
        console.log(chalk.blue(`Memulai monitoring via polling setiap 1 detik untuk ${this.currentPosition.symbol}...`));
        this.fallbackToPolling();
    }

    /**
     * Fallback ke polling jika WebSocket gagal
     */
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

                // Kalkulasi PNL saat ini
                const pnl = ((currentPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice) * 100;

                // Update harga tertinggi (untuk Trailing Stop)
                if (currentPrice > this.currentPosition.maxPrice) {
                    this.currentPosition.maxPrice = currentPrice;
                }

                // Kalkulasi PNL dari titik tertinggi (Peak PNL)
                const maxPnl = ((this.currentPosition.maxPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice) * 100;

                process.stdout.write(chalk.white(`\rMonitoring ${this.currentPosition.symbol}: PNL ${pnl.toFixed(2)}% | Max ${maxPnl.toFixed(2)}%    `));

                this.checkExitConditions(currentPrice, pnl, maxPnl);

            } catch (error) {
                console.error(chalk.red("\nError Monitoring:"), error.message);
            }
        }, 1000); // Polling setiap 1 detik
    }

    stopMonitoring() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    /**
     * Logika Exit: Take Profit, Stop Loss, dan Trailing Stop
     */
    checkExitConditions(currentPrice, pnl, maxPnl) {
        const c = config.trading;

        // 1. HARD TAKE PROFIT (10%)
        // Kalau mau bener-bener agresif, ini bisa dilepas agar koin bisa "ride the trend" lebih jauh
        if (pnl >= c.targetProfitPercent) {
            this.closePosition(currentPrice, pnl, "🚀 Moon Target Reached");
            return;
        }

        // 2. PROFIT LOCK AT 6% (Kunci Profit)
        // Jika profit pernah menyentuh >= 6% lalu turun di bawah 6%, langsung jual untuk mengamankan profit
        if (maxPnl >= 6 && pnl < 6) {
            this.closePosition(currentPrice, pnl, `🔒 Profit Lock: Turun di bawah 6% (Locked ${pnl.toFixed(2)}%)`);
            return;
        }

        // 3. DYNAMIC TRAILING STOP (The "Profit Locker")
        // Cek apakah profit sudah melewati ambang batas aktivasi (misal 5%)
        if (pnl >= c.trailingStartPercent) {
            const trailThreshold = this.currentPosition.maxPrice * (1 - (c.trailingStopPercent / 100));

            if (currentPrice <= trailThreshold) {
                this.closePosition(currentPrice, pnl, `🛡️ Trailing Stop: Locked at ${pnl.toFixed(2)}%`);
                return;
            }
        }

        // 4. HARD STOP LOSS (-5%)
        if (pnl <= -c.stopLossPercent) {
            this.closePosition(currentPrice, pnl, "❌ Stop Loss Terkena");
            return;
        }

        // 5. TIME LIMIT (10 Menit)
        // Jika 10 menit tidak ada pergerakan yang berarti, keluar dari trade
        const timeElapsed = (Date.now() - new Date(this.currentPosition.openedAt).getTime()) / (60 * 1000);
        if (timeElapsed >= c.timeLimitMinutes) {
            this.closePosition(currentPrice, pnl, "⌛ Time Limit: No Significant Movement");
            return;
        }
    }

    /**
     * Menutup Posisi, Menyimpan Log, dan Reset State
     */
    async closePosition(price, pnl, reason) {
        this.stopMonitoring();
        const cTrading = config.trading;
        const cRisk = config.riskManagement;
        const tokenAddress = this.currentPosition.address;

        const tradeData = {
            ...this.currentPosition,
            exitPrice: price,
            pnl: pnl,
            reason: reason,
            closedAt: new Date().toISOString()
        };

        try {
            const stats = storage.saveTrade(tradeData);

            // --- LOGIKA MANAJEMEN RISIKO (PENALTI & COOLDOWN) ---
            let state = storage.getState();
            if (!state.tokenStats[tokenAddress]) {
                state.tokenStats[tokenAddress] = { slCount: 0, cooldownUntil: 0, blacklisted: false };
            }
            let tState = state.tokenStats[tokenAddress];

            let alertMsg = "";

            if (pnl < 0) {
                state.consecutiveLosses += 1;
                tState.slCount += 1;

                // 1. Brutal Rugpull Check
                if (pnl <= cRisk.rugpullThresholdPercent) {
                    tState.blacklisted = true;
                    alertMsg = `🚨 *RUGPULL DETECTED* (${pnl.toFixed(2)}%). Koin di-blacklist permanen!`;
                }
                // 2. SL 2x Check
                else if (tState.slCount >= 2) {
                    tState.cooldownUntil = Date.now() + (cRisk.slCooldown2xMinutes * 60 * 1000);
                    alertMsg = `⏸️ *Kena SL 2x*. Blacklist koin ini ${cRisk.slCooldown2xMinutes} menit.`;
                }
                // 3. SL 1x Check
                else {
                    tState.cooldownUntil = Date.now() + (cRisk.slCooldown1xMinutes * 60 * 1000);
                    alertMsg = `⏳ *Kena SL 1x*. Koin di-cooldown ${cRisk.slCooldown1xMinutes} menit.`;
                }

                // 4. Global Pause (Beruntun Loss)
                if (state.consecutiveLosses >= cRisk.maxConsecutiveLosses) {
                    state.globalPauseUntil = Date.now() + (cRisk.globalPauseMinutes * 60 * 1000);
                    state.consecutiveLosses = 0; // Reset counter
                    await telegram.sendMessage(`🛑 *GLOBAL PAUSE DIAKTIFKAN*\nBot mengalami loss ${cRisk.maxConsecutiveLosses}x berturut-turut. Scanner dihentikan selama ${cRisk.globalPauseMinutes} menit untuk menghindari kondisi pasar yang buruk.`);
                }
            } else {
                // Jika Profit, reset consecutive losses global
                state.consecutiveLosses = 0;
                // Berikan cooldown normal 5 menit agar tidak langsung FOMO re-entry
                tState.cooldownUntil = Date.now() + (5 * 60 * 1000);
            }

            storage.saveState(state); // Simpan status terbaru

            // --- NOTIFIKASI TELEGRAM ---
            await telegram.notifyTrade('SELL', tradeData);
            if (alertMsg !== "") {
                await telegram.sendMessage(alertMsg);
            }

        } catch (error) {
            console.error("Gagal menutup posisi:", error.message);
        } finally {
            this.currentPosition = null;
            // Reset flag recovery agar bisa recovery lagi jika bot restart di sesi berikutnya
            this.hasRecovered = false;
        }
    }
}

module.exports = new EngineService();