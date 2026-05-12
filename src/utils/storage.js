const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const TRADES_FILE = path.join(process.cwd(), 'paperTrades.json');
const PORTFOLIO_FILE = path.join(process.cwd(), 'portfolio.json');
const STATE_FILE = path.join(process.cwd(), 'botState.json');

function readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
        console.error(chalk.red(`Gagal membaca file ${filePath}:`), err.message);
        return fallback;
    }
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

const Storage = {
    init() {
        try {
            if (!fs.existsSync(TRADES_FILE)) writeJson(TRADES_FILE, []);
            if (!fs.existsSync(PORTFOLIO_FILE)) {
                writeJson(PORTFOLIO_FILE, {
                    startBalance: 1.0,
                    currentBalance: 1.0,
                    peakBalance: 1.0,
                    maxDrawdown: 0,
                    tradeCount: 0,
                    winCount: 0,
                    lossCount: 0,
                    totalPnLPercent: 0
                });
            }

            if (!fs.existsSync(STATE_FILE)) {
                writeJson(STATE_FILE, {
                    globalPauseUntil: 0,
                    consecutiveLosses: 0,
                    tokenStats: {}
                });
            }
        } catch (err) {
            console.error(chalk.red('Gagal inisialisasi storage:'), err.message);
        }
    },

    getState() {
        return readJson(STATE_FILE, {
            globalPauseUntil: 0,
            consecutiveLosses: 0,
            tokenStats: {}
        });
    },

    saveState(state) {
        writeJson(STATE_FILE, state);
    },

    getPortfolio() {
        return readJson(PORTFOLIO_FILE, {
            startBalance: 1.0,
            currentBalance: 1.0,
            peakBalance: 1.0,
            maxDrawdown: 0,
            tradeCount: 0,
            winCount: 0,
            lossCount: 0,
            totalPnLPercent: 0
        });
    },

    saveTrade(trade) {
        const trades = readJson(TRADES_FILE, []);
        trades.push(trade);
        writeJson(TRADES_FILE, trades);

        const portfolio = this.getPortfolio();
        const profitInSol = (trade.pnl / 100) * trade.positionSize;

        portfolio.currentBalance += profitInSol;
        portfolio.tradeCount += 1;
        if (trade.pnl > 0) portfolio.winCount += 1;
        else portfolio.lossCount += 1;

        if (portfolio.currentBalance > portfolio.peakBalance) {
            portfolio.peakBalance = portfolio.currentBalance;
        }

        const currentDD = ((portfolio.peakBalance - portfolio.currentBalance) / portfolio.peakBalance) * 100;
        if (currentDD > portfolio.maxDrawdown) portfolio.maxDrawdown = currentDD;
        portfolio.totalPnLPercent = ((portfolio.currentBalance - portfolio.startBalance) / portfolio.startBalance) * 100;

        writeJson(PORTFOLIO_FILE, portfolio);
        return portfolio;
    }
};

module.exports = Storage;