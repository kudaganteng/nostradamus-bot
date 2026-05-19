require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const config = require('../../config.json');
const storage = require('../utils/storage');
const { applyRuntimeRiskToPosition, getRuntimeRisk } = require('./runtimeRiskPatch');

class TelegramService {
    constructor() {
        this.chatId = process.env.TELEGRAM_CHAT_ID;
        this.engine = null;
        this.commandsStarted = false;

        if (!process.env.TELEGRAM_BOT_TOKEN) {
            console.warn('[Telegram] TELEGRAM_BOT_TOKEN tidak ditemukan. Telegram dinonaktifkan.');
            this.bot = null;
            return;
        }

        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
    }

    startCommandRuntime(engine) {
        if (!this.bot) return;
        if (this.commandsStarted) return;

        this.engine = engine;
        this.commandsStarted = true;

        this.bot.startPolling();
        this.registerCommandHandlers();
        console.log('[Telegram] Runtime command handler aktif.');
    }

    isAuthorized(msg) {
        if (!this.chatId) return true;
        return String(msg.chat.id) === String(this.chatId);
    }

    async reply(msg, message) {
        if (!this.bot) return;
        await this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
    }

    parsePercent(text) {
        const value = Number(String(text || '').replace('%', '').trim());
        if (!Number.isFinite(value) || value <= 0 || value > 100) {
            return null;
        }
        return value;
    }

    saveRuntimeRisk(partialRisk) {
        const state = storage.getState();
        state.runtimeRisk = {
            ...(state.runtimeRisk || {}),
            ...partialRisk,
            updatedAt: new Date().toISOString()
        };
        storage.saveState(state);
    }

    pauseBot(reason = 'Manual pause via Telegram') {
        const state = storage.getState();
        state.manualPause = {
            enabled: true,
            reason,
            pausedAt: new Date().toISOString()
        };
        state.globalPauseUntil = 0;
        storage.saveState(state);
    }

    resumeBot() {
        const state = storage.getState();
        state.manualPause = {
            ...(state.manualPause || {}),
            enabled: false,
            resumedAt: new Date().toISOString()
        };
        state.globalPauseUntil = 0;
        storage.saveState(state);
    }

    getPauseStatus() {
        const state = storage.getState();
        if (state.manualPause?.enabled === true) {
            const pausedAt = state.manualPause.pausedAt ? new Date(state.manualPause.pausedAt).toLocaleString('id-ID') : '-';
            return `⏸️ *Pause:* Aktif\n*Reason:* ${state.manualPause.reason || '-'}\n*Paused At:* ${pausedAt}`;
        }

        if (state.globalPauseUntil && state.globalPauseUntil > Date.now()) {
            const minutes = Math.ceil((state.globalPauseUntil - Date.now()) / 60000);
            return `⏸️ *Pause:* Aktif ${minutes} menit lagi\nGunakan /resume untuk membatalkan.`;
        }

        return '▶️ *Pause:* Tidak aktif';
    }

    saveActivePositionIfAny() {
        if (this.engine?.currentPosition) {
            storage.saveActivePosition(this.engine.currentPosition);
        }
    }

    setTakeProfit(percent) {
        config.trading.targetProfitPercent = percent;
        this.saveRuntimeRisk({ targetProfitPercent: percent });

        if (this.engine?.currentPosition) {
            this.engine.currentPosition.dynamicTargetProfitPercent = percent;
            this.engine.currentPosition.telegramTargetProfitPercent = percent;
            this.engine.currentPosition.runtimeRiskAppliedAt = new Date().toISOString();
            this.saveActivePositionIfAny();
        }
    }

    setStopLoss(percent) {
        config.trading.stopLossPercent = percent;
        this.saveRuntimeRisk({ stopLossPercent: percent });

        if (this.engine?.currentPosition) {
            this.engine.currentPosition.telegramStopLossPercent = percent;
            this.engine.currentPosition.runtimeRiskAppliedAt = new Date().toISOString();
            this.saveActivePositionIfAny();
        }
    }

    getRuntimeStatusMessage() {
        const position = this.engine?.currentPosition;
        const runtimeRisk = getRuntimeRisk();
        const activeTp = position?.dynamicTargetProfitPercent || runtimeRisk.targetProfitPercent || config.trading.targetProfitPercent;
        const activeSl = position?.telegramStopLossPercent || runtimeRisk.stopLossPercent || config.trading.stopLossPercent;
        const savedTp = runtimeRisk.targetProfitPercent || config.trading.targetProfitPercent;
        const savedSl = runtimeRisk.stopLossPercent || config.trading.stopLossPercent;
        const pauseStatus = this.getPauseStatus();

        if (!position) {
            return `⚙️ *Runtime Risk Settings*\n━━━━━━━━━━━━━━━━━━\n*TP tersimpan:* ${savedTp}%\n*SL tersimpan:* ${savedSl}%\n\n${pauseStatus}\n\nTidak ada posisi aktif. Setting TP/SL akan diterapkan ke entry berikutnya.`;
        }

        const openedAt = position.openedAt ? new Date(position.openedAt).toLocaleString('id-ID') : '-';
        return `⚙️ *Runtime Risk Settings*\n━━━━━━━━━━━━━━━━━━\n*Token:* ${position.symbol}\n*Entry:* $${position.entryPrice}\n*TP aktif:* ${activeTp}%\n*SL aktif:* ${activeSl}%\n*TP tersimpan:* ${savedTp}%\n*SL tersimpan:* ${savedSl}%\n*Opened:* ${openedAt}\n\n${pauseStatus}`;
    }

    registerCommandHandlers() {
        this.bot.onText(/^\/(start|help)$/i, async (msg) => {
            if (!this.isAuthorized(msg)) return;
            await this.reply(msg, `🤖 *Nostradamus Bot Commands*\n━━━━━━━━━━━━━━━━━━\n/settp 12 atau /tp 12\nUbah take profit runtime ke 12%\n\n/setsl 8 atau /sl 8\nUbah stop loss runtime ke 8%\n\n/pause atau /pause alasan\nPause entry baru secara manual\n\n/resume\nLanjutkan scanning dan entry baru\n\n/risk\nLihat TP/SL aktif, TP/SL tersimpan, dan status pause\n\n/position\nLihat posisi aktif`);
        });

        this.bot.onText(/^\/(settp|tp)\s+(.+)$/i, async (msg, match) => {
            if (!this.isAuthorized(msg)) return;
            const percent = this.parsePercent(match[2]);
            if (percent === null) {
                await this.reply(msg, 'Format TP tidak valid. Contoh: `/tp 12`');
                return;
            }

            this.setTakeProfit(percent);
            applyRuntimeRiskToPosition(this.engine);
            await this.reply(msg, `✅ Take profit runtime disimpan ke *${percent}%*${this.engine?.currentPosition ? ` dan diterapkan ke posisi *${this.engine.currentPosition.symbol}*.` : '. Akan diterapkan ke entry berikutnya.'}`);
        });

        this.bot.onText(/^\/(setsl|sl)\s+(.+)$/i, async (msg, match) => {
            if (!this.isAuthorized(msg)) return;
            const percent = this.parsePercent(match[2]);
            if (percent === null) {
                await this.reply(msg, 'Format SL tidak valid. Contoh: `/sl 8`');
                return;
            }

            this.setStopLoss(percent);
            applyRuntimeRiskToPosition(this.engine);
            await this.reply(msg, `✅ Stop loss runtime disimpan ke *${percent}%*${this.engine?.currentPosition ? ` dan diterapkan ke posisi *${this.engine.currentPosition.symbol}*.` : '. Akan diterapkan ke entry berikutnya.'}`);
        });

        this.bot.onText(/^\/pause(?:\s+(.+))?$/i, async (msg, match) => {
            if (!this.isAuthorized(msg)) return;
            const reason = String(match?.[1] || 'Manual pause via Telegram').trim();
            this.pauseBot(reason);
            await this.reply(msg, `⏸️ Bot dipause. Entry baru dihentikan.\nReason: *${reason}*\n\nGunakan /resume untuk melanjutkan.`);
        });

        this.bot.onText(/^\/resume$/i, async (msg) => {
            if (!this.isAuthorized(msg)) return;
            this.resumeBot();
            await this.reply(msg, '▶️ Bot dilanjutkan. Scanner dan entry baru aktif kembali.');
        });

        this.bot.onText(/^\/risk$/i, async (msg) => {
            if (!this.isAuthorized(msg)) return;
            await this.reply(msg, this.getRuntimeStatusMessage());
        });

        this.bot.onText(/^\/position$/i, async (msg) => {
            if (!this.isAuthorized(msg)) return;
            const position = this.engine?.currentPosition;
            const runtimeRisk = getRuntimeRisk();
            if (!position) {
                await this.reply(msg, `Tidak ada posisi aktif.\n\nTP tersimpan: *${runtimeRisk.targetProfitPercent || config.trading.targetProfitPercent}%*\nSL tersimpan: *${runtimeRisk.stopLossPercent || config.trading.stopLossPercent}%*\n\n${this.getPauseStatus()}`);
                return;
            }

            await this.reply(msg, `📌 *Posisi Aktif*\n━━━━━━━━━━━━━━━━━━\n*Token:* ${position.symbol}\n*Entry:* $${position.entryPrice}\n*Size:* ${position.positionSize} SOL\n*TP:* ${position.dynamicTargetProfitPercent || runtimeRisk.targetProfitPercent || config.trading.targetProfitPercent}%\n*SL:* ${position.telegramStopLossPercent || runtimeRisk.stopLossPercent || config.trading.stopLossPercent}%\n*CA:* \`${position.address}\`\n\n${this.getPauseStatus()}`);
        });

        this.bot.on('polling_error', (error) => {
            console.error('[Telegram] Polling error:', error.message);
        });
    }

    async sendMessage(message) {
        if (!this.bot || !this.chatId) return;
        try {
            await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Gagal mengirim pesan Telegram:', error.message);
        }
    }

    async notifyDetection(tokenData) {
        const address = tokenData.baseToken.address;
        const message = `
🎯 *KOIN TERDETEKSI!*
━━━━━━━━━━━━━━━━━━
*Nama:* ${tokenData.baseToken.name}
*CA:* \`${address}\` 
*Liq:* $${tokenData.liquidity.usd}
*Change 5m:* ${tokenData.priceChange.m5}%

[DexScreener](${tokenData.url})
    `;
        await this.sendMessage(message);
    }

    async notifyTrade(type, data) {
        const sign = type === 'BUY' ? '🔵' : '🟢';

        if (type === 'SELL') {
            const portfolio = storage.getPortfolio();
            const profitInSol = Number.isFinite(data.netProfitSol)
                ? data.netProfitSol
                : (data.pnl / 100) * data.positionSize;

            const message = `
${sign} *PAPER TRADE ${type}*
━━━━━━━━━━━━━━━━━━
*Token:* ${data.symbol}
*Entry Price:* $${data.entryPrice}
*Exit Price:* $${data.exitPrice}
*Position Size:* ${data.positionSize} SOL
*Profit/Loss:* ${profitInSol >= 0 ? '+' : ''}${profitInSol.toFixed(6)} SOL
*PNL:* ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(2)}%
*Reason:* ${data.reason}
*Duration:* ${this.formatDuration(data.openedAt, data.closedAt)}

━━━━━━━━━━━━━━━━━━
📊 *PORTFOLIO UPDATE*
━━━━━━━━━━━━━━━━━━
*Balance:* ${portfolio.currentBalance.toFixed(6)} SOL
*Total PNL:* ${portfolio.totalPnLPercent >= 0 ? '+' : ''}${portfolio.totalPnLPercent.toFixed(2)}%
*Trades:* ${portfolio.tradeCount} | ✅ ${portfolio.winCount} | ❌ ${portfolio.lossCount}
*Win Rate:* ${((portfolio.winCount / portfolio.tradeCount) * 100).toFixed(1)}%
*Max Drawdown:* ${portfolio.maxDrawdown.toFixed(2)}%
            `;
            await this.sendMessage(message);
            return;
        }

        const message = `
${sign} *PAPER TRADE ${type}*
━━━━━━━━━━━━━━━━━━
*Token:* ${data.symbol}
*Price:* ${data.price}
*CA:* \`${data.address}\`
        `;
        await this.sendMessage(message);
    }

    formatDuration(openedAt, closedAt) {
        const start = new Date(openedAt);
        const end = new Date(closedAt);
        const diffMs = end - start;
        const diffSecs = Math.floor(diffMs / 1000);
        const mins = Math.floor(diffSecs / 60);
        const secs = diffSecs % 60;
        return `${mins}m ${secs}s`;
    }
}

module.exports = new TelegramService();
