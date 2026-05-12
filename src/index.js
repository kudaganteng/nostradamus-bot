const scanner = require('./services/scanner');
const engine = require('./services/engine');
const activityLogger = require('./utils/activityLogger'); // <--- Tambahkan import ini
const chalk = require('chalk');

let isObserving = false; // Flag untuk memastikan bot tidak dobel observasi

async function startScanLoop() {
    // 1. Jangan scan jika sedang trading atau sedang dalam masa observasi 45 detik
    if (engine.currentPosition || isObserving) {
        setTimeout(startScanLoop, 5000);
        return;
    }

    try {
        const target = await scanner.findOpportunities();

        if (target) {
            console.log(chalk.bgGreen.black.bold(`\n\n🎯 TARGET MATCH: ${target.baseToken.symbol} `));
            
            // Mulai fase penahanan (Observasi PA)
            isObserving = true;
            const isConfirmed = await engine.observeAndConfirm(target);
            isObserving = false;

            if (isConfirmed) {
                // Jika lolos tes 45 detik, baru eksekusi Buy
                await engine.openPosition(target);
            } else {
                // Jika gagal (misal gagal breakout), berikan hukuman ringan agar tidak di-scan ulang dalam waktu dekat
                console.log(chalk.gray(`[Info] Memasukkan ${target.baseToken.symbol} ke cooldown 3 menit karena gagal konfirmasi PA.`));
                scanner.addToCooldown(target.baseToken.address, 3); // Pastikan scanner kamu punya fungsi addToCooldown (dalam menit)
            }
        } 
    } catch (error) {
        console.error(chalk.red("\n[Loop Error]:"), error.message);
        isObserving = false;
    } finally {
        setTimeout(startScanLoop, 3000); // Looping utama
    }
}

console.log(chalk.cyan.bold("====================================="));
console.log(chalk.cyan.bold("  SOLANA SCALPER (SNIPER MODE v3)    "));
console.log(chalk.cyan.bold("====================================="));

activityLogger.init();

startScanLoop();