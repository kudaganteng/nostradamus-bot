require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

class TelegramService {
    constructor() {
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
        this.chatId = process.env.TELEGRAM_CHAT_ID;
    }

    async sendMessage(message) {
        try {
            await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Gagal mengirim pesan Telegram:', error.message);
        }
    }

    async notifyDetection(tokenData) {
        const address = tokenData.baseToken.address; // Ambil address
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
        const message = `
${sign} *PAPER TRADE ${type}*
━━━━━━━━━━━━━━━━━━
*Token:* ${data.symbol}
*Price:* ${data.price}
*CA:* \`${data.address}\`
${data.pnl ? '*PNL:* ' + data.pnl.toFixed(2) + '%' : ''}
${data.reason ? '*Reason:* ' + data.reason : ''}
        `;
        await this.sendMessage(message);
    }
}

module.exports = new TelegramService();