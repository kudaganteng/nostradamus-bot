const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const LOG_FILE = path.join(process.cwd(), 'botActivity.json');

const ActivityLogger = {
    init() {
        try {
            if (!fs.existsSync(LOG_FILE)) {
                fs.writeFileSync(LOG_FILE, JSON.stringify([], null, 2), 'utf8');
                console.log(chalk.blue("✓ File botActivity.json berhasil dibuat."));
            }
            // Catat bahwa bot baru saja dinyalakan
            this.log("BOT_STARTED", { message: "Scanner dan Logger online." });
        } catch (err) {
            console.error(chalk.red("Gagal membuat botActivity.json:"), err.message);
        }
    },

    log(action, details = {}) {
        try {
            let logs = [];
            if (fs.existsSync(LOG_FILE)) {
                const fileData = fs.readFileSync(LOG_FILE, 'utf8');
                if (fileData) {
                    logs = JSON.parse(fileData);
                }
            }

            const newLog = {
                timestamp: new Date().toISOString(),
                action: action,
                ...details
            };

            logs.unshift(newLog); // Tambahkan log baru di urutan paling atas

            // Batasi maksimal 200 aktivitas agar file tidak membengkak
            const trimmedLogs = logs.slice(0, 200);
            
            fs.writeFileSync(LOG_FILE, JSON.stringify(trimmedLogs, null, 2), 'utf8');
        } catch (err) {
            console.error(chalk.red("Gagal menulis log aktivitas:"), err.message);
        }
    }
};

module.exports = ActivityLogger;