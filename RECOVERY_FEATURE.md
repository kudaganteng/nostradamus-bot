# Fitur Recovery Posisi Aktif

## Deskripsi
Bot sekarang memiliki kemampuan untuk mengingat dan melanjutkan trade yang sedang berjalan apabila bot berhenti secara tiba-tiba (crash, restart, atau error).

## Cara Kerja

### 1. Saat Membuka Posisi (BUY)
- Ketika bot membuka posisi baru, data posisi disimpan ke file `activePosition.json`
- File ini berisi informasi lengkap tentang trade: symbol, entry price, pair address, dll.

### 2. Saat Bot Restart
- Ketika bot dinyalakan kembali, constructor di `engine.js` akan:
  - Memeriksa apakah ada file `activePosition.json`
  - Jika ada, bot akan memuat posisi tersebut dan langsung melanjutkan monitoring
  - Jika tidak ada, bot berjalan normal tanpa posisi aktif

### 3. Saat Menutup Posisi (SELL)
- Ketika posisi ditutup (take profit, stop loss, atau time limit), file `activePosition.json` otomatis dihapus
- Ini menandakan tidak ada lagi posisi yang berjalan

## File yang Dimodifikasi

### `/workspace/src/utils/storage.js`
- Ditambahkan konstanta `POSITION_FILE` untuk path file `activePosition.json`
- Fungsi baru `saveActivePosition(position)` - menyimpan posisi aktif
- Fungsi baru `loadActivePosition()` - memuat posisi aktif saat restart
- Fungsi `saveTrade(trade)` dimodifikasi untuk menghapus file posisi setelah trade ditutup

### `/workspace/src/services/engine.js`
- Constructor dimodifikasi untuk memanggil `storage.loadActivePosition()` saat startup
- Jika ada posisi yang tersimpan, bot otomatis melanjutkan monitoring
- Fungsi `openPosition(token)` dimodifikasi untuk memanggil `storage.saveActivePosition()` setelah posisi dibuka

## Testing
Fitur ini sudah ditest dengan skenario:
1. ✅ Menyimpan posisi aktif ke file
2. ✅ Memuat posisi aktif dari file
3. ✅ File otomatis dihapus setelah trade ditutup

## Keuntungan
- **Anti-Crash**: Bot tidak kehilangan trade yang sedang berjalan jika terjadi crash
- **Auto-Recovery**: Bot otomatis melanjutkan monitoring setelah restart tanpa intervensi manual
- **Data Persistence**: Semua informasi trade tersimpan dengan aman di filesystem
