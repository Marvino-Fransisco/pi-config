# Cara tes long-term memory

Panduan ini memakai data contoh, bukan informasi pribadi. Teks memory dan query semantic dikirim ke Google Gemini, jadi jangan gunakan API key, password, atau data sensitif sebagai teks tes.

## 1. Siapkan extension

Jalankan di terminal dari root repo:

```zsh
cd ~/Documents/work/tools/pi-config
npm install
if [ ! -e "$HOME/.pi/agent/extensions/long-memory" ] && [ ! -L "$HOME/.pi/agent/extensions/long-memory" ]; then
  ln -s "$PWD/extensions/long-memory" "$HOME/.pi/agent/extensions/long-memory"
fi
```

Jika path extension tersebut sudah ada, periksa dulu tujuannya dan jangan timpa file atau symlink yang sudah ada.

## 2. Isi konfigurasi sekali

File konfigurasi berada di `extensions/long-memory/.env`. Jika belum ada, buat dari contoh tanpa menimpa file yang sudah ada:

```zsh
if [ ! -e extensions/long-memory/.env ]; then
  cp extensions/long-memory/.env.example extensions/long-memory/.env
fi
chmod 600 extensions/long-memory/.env
nano extensions/long-memory/.env
```

Isi `MEMORY_DB_PASSWORD`, `MEMORY_READER_PASSWORD`, dan `GEMINI_API_KEY`. Gunakan dua password database yang berbeda dan kuat, lalu simpan keduanya di password manager. Password hexadecimal menghindari masalah karakter khusus. `MEMORY_DB_PORT` pada template adalah `55434`.

Jangan tulis nilai rahasia di chat atau commit file `.env`. Extension membacanya otomatis; environment variable yang sudah ada di proses Pi tetap lebih diprioritaskan. Password yang sudah digunakan untuk membuat database tidak berubah hanya karena file `.env` diedit.

## 3. Jalankan PostgreSQL

Pastikan Docker Desktop berjalan, lalu dari root repo:

```zsh
docker compose --env-file extensions/long-memory/.env -f extensions/long-memory/docker/compose.yml up -d --build --wait
```

Periksa statusnya:

```zsh
docker compose --env-file extensions/long-memory/.env -f extensions/long-memory/docker/compose.yml ps
```

Harapannya service `postgres` berstatus berjalan dan `healthy`. Container menggunakan Docker named volume; `docker compose down -v` menghapus volume dan seluruh data di dalamnya. Jangan gunakan opsi itu untuk database yang ingin disimpan.

Untuk database yang sudah ada, buat backup dengan `pg_dump`, kemudian jalankan migration tambahan sebelum memakai update/supersede:

```zsh
docker compose --env-file extensions/long-memory/.env -f extensions/long-memory/docker/compose.yml exec -T postgres psql -U memory_owner -d pi_memory -v ON_ERROR_STOP=1 < extensions/long-memory/docker/migrate.sql
```

Migration ini dapat dijalankan ulang dan tidak menghapus memory.

## 4. Muat extension di Pi

Buka Pi dari proyek yang ingin dites, lalu jalankan:

```text
/reload
```

Perintah `/memory` seharusnya tersedia. Kalau tidak, pastikan symlink pada langkah 1 menunjuk ke `extensions/long-memory` di repo ini, lalu reload lagi.

## 5. Simpan dan lihat memory global

Di Pi, jalankan:

```text
/memory save global Untuk tes, saya suka contoh penjelasan singkat.
```

Setujui dialog konfirmasi. Harapannya tampil `Saved memory #<id>` dan `Indexed for semantic search`. Catat ID yang ditampilkan; ID tidak selalu sama di setiap database. Tekan `Esc` untuk menutup tampilan hasil.

Lalu jalankan:

```text
/memory list global
```

Memory contoh tadi harus terlihat. Untuk melihat isi lengkap, ganti `<id>` dengan ID yang kamu catat:

```text
/memory show <id>
```

Kalau tampil `not indexed` atau pesan kegagalan indexing, teksnya tetap tersimpan tetapi belum bisa ditemukan lewat semantic search. Periksa Gemini API key dan koneksi internet, lalu ulangi indexing dengan `/memory update <id> <teks yang sama>` dan setujui konfirmasi.

## 6. Tes memory proyek

Masih di Pi yang dibuka dari proyek yang sama:

```text
/memory save project Untuk tes, proyek ini memakai PostgreSQL.
```

Setujui konfirmasi dan catat ID-nya. Lalu cek:

```text
/memory list project
/memory list
/memory projects
```

`list project` menampilkan memory proyek aktif; `list` menampilkan global dan proyek aktif. `projects` menampilkan daftar proyek yang telah memiliki memory proyek. Identitas proyek memakai Git checkout root; worktree berbeda dianggap proyek berbeda.

Untuk menguji isolasi, buka Pi dari checkout Git lain, lalu jalankan `/memory list` dan `/memory list project`. Memory proyek pertama tidak boleh muncul, sedangkan memory global tetap dapat dilihat lewat `/memory list global`.

## 7. Tes semantic search dan TUI

Jalankan:

```text
/memory search preferensi gaya penjelasan
```

Hasilnya seharusnya mencakup memory global tentang penjelasan singkat. Semantic search mengurutkan berdasarkan kemiripan, jadi urutan dan skor dapat berbeda. Hasil dibatasi lima memory teratas yang sudah terindeks; tidak ada minimum similarity threshold.

Untuk memakai search bar:

```text
/memory
```

1. Tampilan awal STATS menunjukkan jumlah memory dan status indexing. `Tab` berpindah antara STATS, SEARCH, LIST, DEBUG, dan SQL.
2. Pada SEARCH, ketik `preferensi penjelasan`, lalu `Enter`. Gunakan `↑`/`↓` untuk memilih hasil dan `Enter` untuk detail; `Esc` kembali.
3. `Ctrl+S` mengganti scope kecuali pada SQL. Pada LIST, input opsional memfilter kind; `Ctrl+N/P` berpindah halaman 50 memory.
4. Pada DEBUG, jalankan query yang sama; cek strategi exact cosine, jumlah kandidat/indexed/unindexed, waktu, skor, dan detail hasil.
5. `Esc` melepas fokus tetapi panel kanan atas tetap terbuka. `/memory` memfokuskan kembali; panggil lagi saat fokus untuk menutup. Pada terminal sempit, `Esc` menutup fallback full-screen.
6. Panggil `/task`, `/context`, lalu `/memory`: setiap command menggantikan panel sebelumnya. Panah kiri/kanan tidak berpindah antar-panel.

Pencarian membutuhkan koneksi internet dan Gemini API key. Jika Google gagal atau kuota habis, error akan ditampilkan; hasil keyword biasa tidak diam-diam digunakan sebagai pengganti.

Cek juga command berikut:

```text
/memory stats
/memory debug preferensi penjelasan
/memory list both note 0
/memory list both - 50
```

Simpan lagi teks yang sama ke scope yang sama: hasil harus `Reused existing memory`, bukan ID baru. Coba `/memory supersede <id> <teks pengganti>`, setujui konfirmasi, lalu `/memory history <id>`: versi lama harus ada, sedangkan search hanya melihat versi aktif. Menolak konfirmasi tidak boleh mengubah data.

## 8. Tes query SQL read-only

```sql
/memory query SELECT id, project_id, kind, content FROM memories ORDER BY id DESC
```

Hasil query tampil dalam panel yang dapat di-scroll. Query ini dapat melihat semua proyek dan menggunakan role database khusus read-only. Hasil dibatasi hingga 100 baris dan 30.000 karakter.

## 9. Tes lewat agent dan hapus data contoh

Kirim pesan biasa ke agent:

```text
Simpan sebagai memory global bahwa ini adalah contoh pengujian sementara.
```

Agent harus meminta konfirmasi sebelum menyimpan. Menolak konfirmasi harus membatalkan penyimpanan. Kamu juga bisa meminta agent mencari atau menampilkan memory.

Untuk menghapus contoh tes, pakai ID masing-masing yang ditampilkan saat penyimpanan:

```text
/memory delete <id>
```

Setujui konfirmasi hanya untuk ID yang memang ingin dihapus, lalu cek dengan `/memory list`. Penghapusan bersifat permanen dan ikut menghapus embedding serta riwayat revisi terkait.

## 10. Tes otomatis opsional

Dari terminal di root repo:

```zsh
npm test
npm run typecheck
```

Tes PostgreSQL otomatis dilewati tanpa URL database tes khusus. Tes itu melakukan `TRUNCATE`: **jangan arahkan ke database berisi memory asli**. Persyaratan database disposable dijelaskan di `extensions/long-memory/README.md` bagian Verification.
