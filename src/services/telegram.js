require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const storage = require('../utils/storage');

function n(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

class TelegramService {
    constructor() {
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
        this.chatId = process.env.TELEGRAM_CHAT_ID;
        this.controlsStarted = false;
    }

    isAllowedChat(msgOrQuery) {
        const chatId = msgOrQuery?.message?.chat?.id || msgOrQuery?.chat?.id;
        return String(chatId) === String(this.chatId);
    }

    getSettingsKeyboard() {
        return {
            inline_keyboard: [
                [
                    { text: 'TP -1%', callback_data: 'risk:tp:-1' },
                    { text: 'TP -0.5%', callback_data: 'risk:tp:-0.5' },
                    { text: 'TP +0.5%', callback_data: 'risk:tp:0.5' },
                    { text: 'TP +1%', callback_data: 'risk:tp:1' }
                ],
                [
                    { text: 'SL -1%', callback_data: 'risk:sl:-1' },
                    { text: 'SL -0.5%', callback_data: 'risk:sl:-0.5' },
                    { text: 'SL +0.5%', callback_data: 'risk:sl:0.5' },
                    { text: 'SL +1%', callback_data: 'risk:sl:1' }
                ],
                [
                    { text: 'Refresh', callback_data: 'risk:refresh:0' },
                    { text: 'Apply to active position', callback_data: 'risk:apply:0' }
                ]
            ]
        };
    }

    formatSettings(engine = null) {
        const settings = storage.getRuntimeSettings();
        const active = engine?.currentPosition;
        const activeText = active
            ? `\n\n📌 *Active Position*\n*Token:* ${active.symbol}\n*Active TP:* ${n(active.dynamicTargetProfitPercent, settings.targetProfitPercent).toFixed(2)}%\n*Active SL:* ${n(active.dynamicStopLossPercent, settings.stopLossPercent).toFixed(2)}%`
            : '\n\n📌 *Active Position:* none';

        return `
⚙️ *Runtime Risk Settings*
━━━━━━━━━━━━━━━━━━
*Take Profit:* ${settings.targetProfitPercent.toFixed(2)}%
*Stop Loss:* ${settings.stopLossPercent.toFixed(2)}%
*Trailing Start:* ${settings.trailingStartPercent.toFixed(2)}%
*Trailing Stop:* ${settings.trailingStopPercent.toFixed(2)}%
*Updated:* ${settings.updatedAt || 'from config'}
${activeText}

Commands:
/settp 5
/setsl 7
/settings
        `;
    }

    async sendMessage(message, options = {}) {
        try {
            await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown', ...options });
        } catch (error) {
            console.error('Gagal mengirim pesan Telegram:', error.message);
        }
    }

    parsePercentCommand(text) {
        const [, rawValue] = String(text || '').trim().split(/\s+/);
        const value = Number(rawValue);
        if (!Number.isFinite(value)) return null;
        return clamp(value, 0.1, 100);
    }

    saveSettingAndMaybeApply(engine, patch, label) {
        const settings = storage.saveRuntimeSettings(patch, 'telegram');
        if (engine?.currentPosition) engine.applyRuntimeSettingsToCurrentPosition?.();
        return { settings, message: `${label} updated.` };
    }

    startControls(engine) {
        if (this.controlsStarted) return;
        if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
            console.log('[Telegram] Controls disabled: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID belum lengkap.');
            return;
        }

        this.bot.stopPolling().catch(() => {});
        this.bot.startPolling();
        this.controlsStarted = true;

        this.bot.onText(/\/settings/, async (msg) => {
            if (!this.isAllowedChat(msg)) return;
            await this.bot.sendMessage(msg.chat.id, this.formatSettings(engine), {
                parse_mode: 'Markdown',
                reply_markup: this.getSettingsKeyboard()
            });
        });

        this.bot.onText(/\/risk/, async (msg) => {
            if (!this.isAllowedChat(msg)) return;
            await this.bot.sendMessage(msg.chat.id, this.formatSettings(engine), {
                parse_mode: 'Markdown',
                reply_markup: this.getSettingsKeyboard()
            });
        });

        this.bot.onText(/\/settp(?:\s+(.+))?/, async (msg) => {
            if (!this.isAllowedChat(msg)) return;
            const value = this.parsePercentCommand(msg.text);
            if (value === null) return this.bot.sendMessage(msg.chat.id, 'Format: /settp 5');
            this.saveSettingAndMaybeApply(engine, { targetProfitPercent: value }, 'TP');
            await this.bot.sendMessage(msg.chat.id, this.formatSettings(engine), {
                parse_mode: 'Markdown',
                reply_markup: this.getSettingsKeyboard()
            });
        });

        this.bot.onText(/\/setsl(?:\s+(.+))?/, async (msg) => {
            if (!this.isAllowedChat(msg)) return;
            const value = this.parsePercentCommand(msg.text);
            if (value === null) return this.bot.sendMessage(msg.chat.id, 'Format: /setsl 7');
            this.saveSettingAndMaybeApply(engine, { stopLossPercent: value }, 'SL');
            await this.bot.sendMessage(msg.chat.id, this.formatSettings(engine), {
                parse_mode: 'Markdown',
                reply_markup: this.getSettingsKeyboard()
            });
        });

        this.bot.on('callback_query', async (query) => {
            if (!this.isAllowedChat(query)) return;
            const [scope, field, rawDelta] = String(query.data || '').split(':');
            if (scope !== 'risk') return;

            try {
                const current = storage.getRuntimeSettings();
                if (field === 'refresh') {
                    await this.bot.answerCallbackQuery(query.id, { text: 'Refreshed' });
                } else if (field === 'apply') {
                    const updated = engine?.applyRuntimeSettingsToCurrentPosition?.();
                    await this.bot.answerCallbackQuery(query.id, { text: updated ? 'Applied to active position' : 'No active position' });
                } else if (field === 'tp') {
                    const next = clamp(current.targetProfitPercent + n(rawDelta, 0), 0.1, 100);
                    this.saveSettingAndMaybeApply(engine, { targetProfitPercent: next }, 'TP');
                    await this.bot.answerCallbackQuery(query.id, { text: `TP ${next.toFixed(2)}%` });
                } else if (field === 'sl') {
                    const next = clamp(current.stopLossPercent + n(rawDelta, 0), 0.1, 100);
                    this.saveSettingAndMaybeApply(engine, { stopLossPercent: next }, 'SL');
                    await this.bot.answerCallbackQuery(query.id, { text: `SL ${next.toFixed(2)}%` });
                }

                await this.bot.editMessageText(this.formatSettings(engine), {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: this.getSettingsKeyboard()
                });
            } catch (error) {
                await this.bot.answerCallbackQuery(query.id, { text: error.message, show_alert: true }).catch(() => {});
            }
        });

        console.log('[Telegram] Runtime TP/SL controls enabled. Commands: /settings, /settp 5, /setsl 7');
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
            const storage = require('../utils/storage');
            const portfolio = storage.getPortfolio();
            const profitInSol = Number.isFinite(Number(data.netPnlSol))
                ? Number(data.netPnlSol)
                : (data.pnl / 100) * data.positionSize;
            const winRate = portfolio.tradeCount > 0
                ? ((portfolio.winCount / portfolio.tradeCount) * 100).toFixed(1)
                : '0.0';
            
            const message = `
${sign} *PAPER TRADE ${type}*
━━━━━━━━━━━━━━━━━━
*Token:* ${data.symbol}
*Quoted Entry:* $${data.quotedEntryPrice || data.entryPrice}
*Executed Entry:* $${data.entryPrice}
*Quoted Exit:* $${data.quotedExitPrice || data.exitPrice}
*Executed Exit:* $${data.exitPrice}
*Position Size:* ${data.positionSize} SOL
*Token Units:* ${Number(data.receivedTokenUnits || 0).toFixed(6)}
*Profit/Loss:* ${profitInSol >= 0 ? '+' : ''}${profitInSol.toFixed(6)} SOL
*Net PNL:* ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(2)}%
*Market PNL:* ${Number(data.grossMarketPnlPercent || data.pnl).toFixed(2)}%
*Total Fees:* ${Number(data.totalFeeSol || 0).toFixed(6)} SOL
*Buy Slip:* ${data.buySlippageBps || 0} bps
*Sell Slip:* ${data.sellSlippageBps || 0} bps
*Failed Sell Fees:* ${Number(data.accumulatedFailedSellFeesSol || 0).toFixed(6)} SOL
*Reason:* ${data.reason}
*Duration:* ${this.formatDuration(data.openedAt, data.closedAt)}

━━━━━━━━━━━━━━━━━━
📊 *PORTFOLIO UPDATE*
━━━━━━━━━━━━━━━━━━
*Balance:* ${portfolio.currentBalance.toFixed(6)} SOL
*Total PNL:* ${portfolio.totalPnLPercent >= 0 ? '+' : ''}${portfolio.totalPnLPercent.toFixed(2)}%
*Trades:* ${portfolio.tradeCount} | ✅ ${portfolio.winCount} | ❌ ${portfolio.lossCount}
*Win Rate:* ${winRate}%
*Max Drawdown:* ${portfolio.maxDrawdown.toFixed(2)}%
            `;
            await this.sendMessage(message);
            return;
        }
        
        const message = `
${sign} *PAPER TRADE ${type}*
━━━━━━━━━━━━━━━━━━
*Token:* ${data.symbol}
*Quoted Price:* $${data.quotedPrice || data.price}
*Executed Price:* $${data.price}
*Fee:* ${Number(data.feeSol || 0).toFixed(6)} SOL
*Slippage:* ${data.slippageBps || 0} bps
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
