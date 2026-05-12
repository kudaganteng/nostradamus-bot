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
        this.currentPosition = null;
        this.checkInterval = null;
        this.pairEndpoint = 'https://api.dexscreener.com/latest/dex/pairs/solana/';
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
            return null;
        }
    }

    async observeAndConfirm(token) {
        activityLogger.log("OBSERVATION_START", { symbol: token.baseToken.symbol });
        const obs = config.observation;
        console.log(chalk.cyan(`\n[Observer] 🕵️ Menunda Entry. Mengawasi ${token.baseToken.symbol} selama ${obs.durationSeconds} detik...`));

        let prices = [];
        const iterations = Math.floor(obs.durationSeconds / obs.intervalSeconds);

        for (let i = 0; i < iterations; i++) {
            const currentPrice = await this.getCurrentPrice(token.pairAddress, true);
            if (currentPrice) prices.push(currentPrice);

            // Tampilkan indikator loading di terminal
            process.stdout.write(chalk.gray(`> Merekam aksi harga: ${prices.length}/${iterations} detik...\r`));

            await new Promise(resolve => setTimeout(resolve, obs.intervalSeconds * 1000));
        }

        if (prices.length < 3) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Data harga tidak cukup stabil dari RPC.`));
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
     * Loop Monitoring Harga (Setiap 2-3 detik)
     */
    startMonitoring() {
        console.log(chalk.blue(`Memulai monitoring intensif untuk ${this.currentPosition.symbol}...`));

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
                    // console.log(chalk.cyan(`New High: $${currentPrice}`));
                }

                // Kalkulasi PNL dari titik tertinggi (Peak PNL)
                const maxPnl = ((this.currentPosition.maxPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice) * 100;

                process.stdout.write(chalk.white(`\rMonitoring ${this.currentPosition.symbol}: PNL ${pnl.toFixed(2)}% | Max ${maxPnl.toFixed(2)}%    `));

                this.checkExitConditions(currentPrice, pnl, maxPnl);

            } catch (error) {
                console.error(chalk.red("\nError Monitoring:"), error.message);
            }
        }, 3000); // Polling setiap 3 detik agar aman dari rate limit tier gratis
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

        // 2. DYNAMIC TRAILING STOP (The "Profit Locker")
        // Cek apakah profit sudah melewati ambang batas aktivasi (misal 5%)
        if (pnl >= c.trailingStartPercent) {
            const trailThreshold = this.currentPosition.maxPrice * (1 - (c.trailingStopPercent / 100));

            if (currentPrice <= trailThreshold) {
                this.closePosition(currentPrice, pnl, `🛡️ Trailing Stop: Locked at ${pnl.toFixed(2)}%`);
                return;
            }
        }

        // 3. HARD STOP LOSS (-5%)
        if (pnl <= -c.stopLossPercent) {
            this.closePosition(currentPrice, pnl, "❌ Stop Loss Terkena");
            return;
        }

        // 4. TIME LIMIT (10 Menit)
        const timeElapsed = (Date.now() - new Date(this.currentPosition.openedAt).getTime()) / (60 * 1000);
        if (timeElapsed >= c.timeLimitMinutes) {
            this.closePosition(currentPrice, pnl, "⌛ Time Limit: No Action");
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
        }
    }
}

module.exports = new EngineService();