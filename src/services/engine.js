const axios = require('axios');
const chalk = require('chalk');
const config = require('../../config.json');
const telegram = require('./telegram');
const storage = require('../utils/storage');
const scanner = require('./scanner');
const activityLogger = require('../utils/activityLogger');

class EngineService {
    constructor() {
        // Inisialisasi storage saat engine dinyalakan
        storage.init();
        this.currentPosition = null;
        this.checkInterval = null;
        this.pairEndpoint = 'https://api.dexscreener.com/latest/dex/pairs/solana/';
    }

    async observeAndConfirm(token) {
        activityLogger.log("OBSERVATION_START", { symbol: token.baseToken.symbol });
        const obs = config.observation;
        console.log(chalk.cyan(`\n[Observer] 🕵️ Menunda Entry. Mengawasi ${token.baseToken.symbol} selama ${obs.durationSeconds} detik...`));

        let prices = [];
        const iterations = Math.floor(obs.durationSeconds / obs.intervalSeconds);

        for (let i = 0; i < iterations; i++) {
            const currentPrice = await this.getCurrentPrice(token.pairAddress);
            if (currentPrice) prices.push(currentPrice);

            // Tampilkan indikator loading di terminal
            process.stdout.write(chalk.gray(`> Merekam aksi harga: ${prices.length}/${iterations} detik...\r`));

            await new Promise(resolve => setTimeout(resolve, obs.intervalSeconds * 1000));
        }

        const result = {
            initialResistance,
            localLow,
            finalPrice,
            dumpPercent: dumpPercent.toFixed(2) + "%"
        };

        if (finalPrice > initialResistance && minPricePhase3 >= localLow) {
            activityLogger.log("OBSERVATION_SUCCESS", { symbol: token.baseToken.symbol, ...result });
            return true;
        } else {
            activityLogger.log("OBSERVATION_FAILED", {
                symbol: token.baseToken.symbol,
                reason: finalPrice <= initialResistance ? "No Breakout" : "Structure Broken",
                ...result
            });
            return false;
        }

        if (prices.length < 5) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Data harga tidak cukup stabil dari RPC.`));
            return false;
        }

        // --- ANALISIS STRUKTUR PASAR (MINI-CHART) ---
        // Kita bagi 45 detik menjadi 3 fase: Awal (Resistance), Tengah (Pullback/Low), Akhir (Breakout)
        const third = Math.floor(prices.length / 3);
        const phase1 = prices.slice(0, third);
        const phase2 = prices.slice(third, third * 2);
        const phase3 = prices.slice(third * 2);

        const initialResistance = Math.max(...phase1);
        const localLow = Math.min(...phase1, ...phase2); // Titik terendah selama fase 1 & 2
        const finalPrice = prices[prices.length - 1];

        // 1. Syarat Pullback: Harga harus sempat turun dari resistance awal (Syarat Reversal)
        if (localLow >= initialResistance) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Koin naik lurus (Vertical Pump). Terlalu berisiko beli pucuk.`));
            return false;
        }

        // 2. Syarat Dump Tolerance: Turunnya tidak boleh seperti rugpull (> 10%)
        const dumpPercent = ((initialResistance - localLow) / initialResistance) * 100;
        if (dumpPercent > obs.maxDumpPercent) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Drop terlalu dalam (${dumpPercent.toFixed(2)}%). Struktur rusak.`));
            return false;
        }

        // 3. Syarat Breakout & Reclaim: Harga akhir harus menembus resistance awal
        if (finalPrice <= initialResistance) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Gagal Breakout. Res: $${initialResistance.toFixed(6)} | Final: $${finalPrice.toFixed(6)}`));
            return false;
        }

        // 4. Syarat Higher Low: Titik terendah (Low) tidak terjadi di fase akhir
        const minPricePhase3 = Math.min(...phase3);
        if (minPricePhase3 < localLow) {
            console.log(chalk.yellow(`\n[Observer] ❌ Ditolak: Membentuk Lower Low. Sedang downtrend.`));
            return false;
        }

        console.log(chalk.green.bold(`\n[Observer] ✅ TERKONFIRMASI! Reversal + Breakout terdeteksi. Mengeksekusi BUY!`));
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

    /**
     * Mengambil harga terbaru dari DexScreener
     */
    async getCurrentPrice(pairAddress) {
        try {
            const resp = await axios.get(`${this.pairEndpoint}${pairAddress}`);
            if (resp.data && resp.data.pair) {
                return parseFloat(resp.data.pair.priceUsd);
            }
            return null;
        } catch (error) {
            return null;
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
            // Hitung batas harga jual (Harga Tertinggi - Jarak Trailing)
            const trailThreshold = this.currentPosition.maxPrice * (1 - (c.trailingDistancePercent / 100));

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