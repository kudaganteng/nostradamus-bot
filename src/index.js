const scanner = require('./services/scanner');
const engine = require('./services/engine');
const gmgn = require('./services/gmgnService');
const config = require('../config.json');
const applyJupiterFullPricePatch = require('./services/jupiterFullPricePatch');
const activityLogger = require('./utils/activityLogger');
const storage = require('./utils/storage');
const chalk = require('chalk');

applyJupiterFullPricePatch(engine);

let isObserving = false;
let scanCounter = 0;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function coolDownToken(target, minutes, reason) {
    const state = storage.getState();
    state.tokenStats[target.baseToken.address] = state.tokenStats[target.baseToken.address] || { slCount: 0, cooldownUntil: 0, blacklisted: false };
    state.tokenStats[target.baseToken.address].cooldownUntil = Date.now() + (minutes * 60 * 1000);
    storage.saveState(state);
    console.log(chalk.gray(`[Info] Memasukkan ${target.baseToken.symbol} ke cooldown ${minutes} menit: ${reason}`));
}

async function startScanLoop() {
    while (true) {
        const sleepMs = engine.currentPosition || isObserving ? 5000 : 3000;

        if (!engine.currentPosition && !isObserving) {
            try {
                scanCounter++;
                const dots = '.'.repeat(scanCounter % 4);
                process.stdout.write(chalk.gray(`\r[Scanner] Memantau market Solana${dots.padEnd(3)} `));

                const target = await scanner.findOpportunities();

                if (target) {
                    console.log(chalk.bgGreen.black.bold(`\n\n🎯 TARGET MATCH: ${target.baseToken.symbol} `));

                    if (config.gmgn?.enabled) {
                        const gmgnCheck = await gmgn.validateToken(target.baseToken.address);
                        if (!gmgnCheck.ok) {
                            console.log(chalk.yellow(`[GMGN] Skip ${target.baseToken.symbol}: ${gmgnCheck.reason}`));
                            coolDownToken(target, config.gmgn?.rejectCooldownMinutes || 5, `GMGN rejected: ${gmgnCheck.reason}`);
                            continue;
                        }
                        console.log(chalk.green(`[GMGN] ${target.baseToken.symbol} passed: ${gmgnCheck.reason}`));
                    }

                    isObserving = true;
                    const isConfirmed = await engine.observeAndConfirm(target);
                    isObserving = false;

                    if (isConfirmed) {
                        await engine.openPosition(target);
                    } else {
                        coolDownToken(target, 3, 'gagal Breakout');
                    }
                }
            } catch (error) {
                console.error(chalk.red("\n[Loop Error]:"), error.message);
                isObserving = false;
            }
        }

        await delay(sleepMs);
    }
}

console.log(chalk.cyan.bold("====================================="));
console.log(chalk.cyan.bold("  SOLANA SCALPER (JUPITER+GMGN v5)   "));
console.log(chalk.cyan.bold("====================================="));

storage.init();
activityLogger.init();

startScanLoop();