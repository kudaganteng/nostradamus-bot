const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const TRADES_FILE = path.join(process.cwd(), 'paperTrades.json');
const PORTFOLIO_FILE = path.join(process.cwd(), 'portfolio.json');
const STATE_FILE = path.join(process.cwd(), 'botState.json');
const POSITION_FILE = path.join(process.cwd(), 'activePosition.json');

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

function defaultState() {
    return {
        tokenStats: {},
        globalPauseUntil: 0,
        dailyRiskTriggeredAt: null,
        dailyRiskReason: null
    };
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
                writeJson(STATE_FILE, defaultState());
            }
        } catch (err) {
            console.error(chalk.red('Gagal inisialisasi storage:'), err.message);
        }
    },

    getState() {
        const state = readJson(STATE_FILE, defaultState()) || defaultState();
        return {
            ...defaultState(),
            ...state,
            tokenStats: state.tokenStats || {},
            globalPauseUntil: Number(state.globalPauseUntil || 0)
        };
    },

    saveState(state) {
        writeJson(STATE_FILE, {
            ...defaultState(),
            ...state,
            tokenStats: state.tokenStats || {},
            globalPauseUntil: Number(state.globalPauseUntil || 0)
        });
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
        const profitInSol = Number.isFinite(trade.netProfitSol)
            ? trade.netProfitSol
            : (trade.pnl / 100) * trade.positionSize;

        portfolio.currentBalance += profitInSol;
        portfolio.tradeCount += 1;
        if (profitInSol > 0) portfolio.winCount += 1;
        else portfolio.lossCount += 1;

        if (portfolio.currentBalance > portfolio.peakBalance) {
            portfolio.peakBalance = portfolio.currentBalance;
        }

        const currentDD = ((portfolio.peakBalance - portfolio.currentBalance) / portfolio.peakBalance) * 100;
        if (currentDD > portfolio.maxDrawdown) portfolio.maxDrawdown = currentDD;
        portfolio.totalPnLPercent = ((portfolio.currentBalance - portfolio.startBalance) / portfolio.startBalance) * 100;

        writeJson(PORTFOLIO_FILE, portfolio);

        if (fs.existsSync(POSITION_FILE)) {
            fs.unlinkSync(POSITION_FILE);
        }

        return portfolio;
    },

    saveActivePosition(position) {
        try {
            writeJson(POSITION_FILE, position);
            console.log(chalk.green('[Storage] Posisi aktif disimpan untuk recovery.'));
        } catch (err) {
            console.error(chalk.red('Gagal menyimpan posisi aktif:'), err.message);
        }
    },

    loadActivePosition() {
        try {
            const position = readJson(POSITION_FILE, null);
            if (position) {
                console.log(chalk.green('[Storage] Posisi aktif ditemukan dan dimuat untuk recovery.'));
                console.log(chalk.cyan(`   Symbol: ${position.symbol}, Entry: $${position.entryPrice.toFixed(6)}`));
            }
            return position;
        } catch (err) {
            console.error(chalk.red('Gagal memuat posisi aktif:'), err.message);
            return null;
        }
    }
};

module.exports = Storage;