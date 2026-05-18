const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs'); 
const path = require('path');
const db = require('./config/db');
const isAuthenticated = require('./middleware/auth');
require('dotenv').config();

const app = express();

// View Engine & Middleware Setup
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // Validitas Sesi 1 Hari
}));

// Global user session variables & query status for templates
app.use((req, res, next) => {
    res.locals.username = req.session.username || null;
    res.locals.email = req.session.email || null;
    res.locals.status = req.query.status || null;
    next();
});

// ================= ROUTING AUTENTIKASI =================

app.get('/login', (req, res) => {
    try {
        if (req.session.userId) return res.redirect('/dashboard');
        res.render('login');
    } catch (error) {
        console.error("🔥 ERROR PADA GET LOGIN:", error);
        res.status(500).send("Server Error di GET /login: " + error.message);
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [users] = await db.query('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
        if (users.length === 0) {
            return res.redirect('/login?status=usernotfound');
        }
        
        const user = users[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.redirect('/login?status=wrongpassword');
        }

        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.email = user.email;
        res.redirect('/dashboard?status=loginsuccess');
    } catch (err) {
        console.error("🔥 ERROR PADA POST LOGIN DATABASE:", err);
        res.status(500).send("Server Error di POST /login: " + err.message);
    }
});

app.get('/register', (req, res) => {
    res.render('register');
});

app.post('/register', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.query('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [username, email, hashedPassword]);
        res.redirect('/login?status=registersuccess');
    } catch (err) {
        res.redirect('/register?status=registerfailed');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login?status=logoutsuccess');
    });
});

// ================= RUTE INTERNAL ADMIN (PROTECTED) =================

app.get('/', isAuthenticated, (req, res) => res.redirect('/dashboard'));

// Dashboard: Menampilkan Tabel Monitoring Saldo Stok Kue Real-time
app.get('/dashboard', isAuthenticated, async (req, res) => {
    try {
        const [stokKue] = await db.query('SELECT rasa, ukuran, stok_sekarang FROM stok_kue ORDER BY rasa ASC, ukuran ASC');
        res.render('dashboard', { stokKue });
    } catch (err) {
        console.error("🔥 Gagal memuat ringkasan stok di dashboard:", err);
        res.status(500).send("Gagal memuat halaman dashboard.");
    }
});

// 1. Input Rencana Produksi (Otomatis Menambah Saldo Stok Kue)
app.get('/produksi', isAuthenticated, async (req, res) => {
    try {
        const hariIni = new Date().toLocaleDateString('fr-CA'); 
        const [produksiHariIni] = await db.query(
            'SELECT * FROM produksi WHERE tanggal_produksi = ? AND user_id = ? ORDER BY created_at DESC', 
            [hariIni, req.session.userId]
        );
        res.render('produksi', { produksiHariIni });
    } catch (err) {
        console.error("🔥 Gagal mengambil data produksi hari ini:", err);
        res.status(500).send("Server Error saat memuat halaman produksi.");
    }
});

app.post('/produksi', isAuthenticated, async (req, res) => {
    const { jumlah_kg, jumlah_kue, rasa, ukuran, tanggal_produksi } = req.body;
    const connection = await db.getConnection(); // Menggunakan Transaksi Database demi akurasi stok
    try {
        await connection.beginTransaction();

        const itemsQty = Array.isArray(jumlah_kue) ? jumlah_kue : [jumlah_kue];
        const itemsRasa = Array.isArray(rasa) ? rasa : [rasa];
        const itemsUkuran = Array.isArray(ukuran) ? ukuran : [ukuran];

        for (let i = 0; i < itemsQty.length; i++) {
            // A. Ambil nilai kuantitas
            const qty = parseInt(itemsQty[i]);
            const rsa = itemsRasa[i];
            const ukr = itemsUkuran[i];

            // B. Masukkan data log produksi ke database
            await connection.query(
                'INSERT INTO produksi (user_id, jumlah_kg, jumlah_kue, rasa, ukuran, tanggal_produksi) VALUES (?, ?, ?, ?, ?, ?)',
                [req.session.userId, jumlah_kg, qty, rsa, ukr, tanggal_produksi]
            );

            // C. TAMBAHKAN SALDO STOK KUE KE TABEL MASTER STOK
            await connection.query(
                'INSERT INTO stok_kue (rasa, ukuran, stok_sekarang) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE stok_sekarang = stok_sekarang + ?',
                [rsa, ukr, qty, qty]
            );
        }

        await connection.commit();
        res.redirect('/produksi?status=produksuccess');
    } catch (err) {
        await connection.rollback();
        console.error("🔥 Gagal menyimpan data produksi dan stok:", err);
        res.redirect('/produksi?status=produksifailed');
    } finally {
        connection.release();
    }
});

// Update Data Item Produksi
app.post('/produksi/update/:id', isAuthenticated, async (req, res) => {
    const { jumlah_kg, jumlah_kue, rasa, ukuran, tanggal_produksi } = req.body;
    try {
        await db.query(
            'UPDATE produksi SET jumlah_kg = ?, jumlah_kue = ?, rasa = ?, ukuran = ?, tanggal_produksi = ? WHERE id = ? AND user_id = ?',
            [jumlah_kg, jumlah_kue, rasa, ukuran, tanggal_produksi, req.params.id, req.session.userId]
        );
        res.redirect('/produksi?status=updatesuccess');
    } catch (err) {
        console.error("🔥 Gagal memperbarui data produksi:", err);
        res.redirect('/produksi?status=updatefailed');
    }
});

// Hapus Data Item Produksi
app.get('/produksi/delete/:id', isAuthenticated, async (req, res) => {
    try {
        await db.query('DELETE FROM produksi WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
        res.redirect('/produksi?status=deletesuccess');
    } catch (err) {
        console.error("🔥 Gagal menghapus data produksi:", err);
        res.redirect('/produksi?status=deletefailed');
    }
});

// 2. Input Pesanan Masuk (Validasi Stok & Otomatis Mengurangi Saldo Stok Kue)
app.get('/pesanan', isAuthenticated, (req, res) => {
    res.render('pesanan');
});

app.post('/pesanan', isAuthenticated, async (req, res) => {
    const { nama_pemesan, tanggal_kirim, jumlah_kue, rasa, ukuran, is_frozen } = req.body;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const itemsQty = Array.isArray(jumlah_kue) ? jumlah_kue : [jumlah_kue];
        const itemsRasa = Array.isArray(rasa) ? rasa : [rasa];
        const itemsUkuran = Array.isArray(ukuran) ? ukuran : [ukuran];
        const itemsFrozen = Array.isArray(is_frozen) ? is_frozen : [is_frozen];

        // --- VALIDASI STOK PERTAMA: Cek ketersediaan seluruh item pesanan ---
        for (let i = 0; i < itemsQty.length; i++) {
            const qtyDibutuhkan = parseInt(itemsQty[i]);
            const rsa = itemsRasa[i];
            const ukr = itemsUkuran[i];

            const [stokCheck] = await connection.query(
                'SELECT stok_sekarang FROM stok_kue WHERE rasa = ? AND ukuran = ?',
                [rsa, ukr]
            );

            const stokTersedia = stokCheck.length > 0 ? stokCheck[0].stok_sekarang : 0;

            if (stokTersedia < qtyDibutuhkan) {
                // Jika stok tidak mencukupi, gagalkan transaksi dan kirim alert notifikasi
                await connection.rollback();
                return res.redirect('/pesanan?status=stockinsufficient');
            }
        }

        // --- EKSEKUSI: Jika stok aman, potong saldo stok dan buat nota pesanan ---
        const [resultMaster] = await connection.query(
            'INSERT INTO pesanan (user_id, nama_pemesan, tanggal_kirim) VALUES (?, ?, ?)',
            [req.session.userId, nama_pemesan, tanggal_kirim]
        );
        const insertIdMaster = resultMaster.insertId;

        for (let i = 0; i < itemsQty.length; i++) {
            const qty = parseInt(itemsQty[i]);
            const rsa = itemsRasa[i];
            const ukr = itemsUkuran[i];
            const frozenVal = itemsFrozen[i] === '1' ? 1 : 0;

            // Simpan detail item pesanan
            await connection.query(
                'INSERT INTO pesanan_detail (pesanan_id, jumlah_kue, rasa, ukuran, is_frozen) VALUES (?, ?, ?, ?, ?)',
                [insertIdMaster, qty, rsa, ukr, frozenVal]
            );

            // KURANGI SALDO STOK KUE KARENA SUDAH TERPESAN
            await connection.query(
                'UPDATE stok_kue SET stok_sekarang = stok_sekarang - ? WHERE rasa = ? AND ukuran = ?',
                [qty, rsa, ukr]
            );
        }

        await connection.commit();
        res.redirect('/pesanan?status=pesanansuccess');
    } catch (err) {
        await connection.rollback();
        console.error("🔥 Gagal memproses data pesanan:", err);
        res.redirect('/pesanan?status=pesananfailed');
    } finally {
        connection.release();
    }
});

// 3. Manage Pesanan 
app.get('/manage-pesanan', isAuthenticated, async (req, res) => {
    try {
        const [orders] = await db.query(`
            SELECT p.id, p.nama_pemesan, p.tanggal_kirim, p.status_bayar, p.catatan,
                   pd.id AS detail_id, pd.jumlah_kue, pd.rasa, pd.ukuran, pd.is_frozen
            FROM pesanan p
            JOIN pesanan_detail pd ON p.id = pd.pesanan_id
            WHERE p.user_id = ?
            ORDER BY p.tanggal_kirim ASC, p.id ASC
        `, [req.session.userId]);
        res.render('manage-pesanan', { orders });
    } catch (err) {
        res.status(500).send("Gagal mengambil data pesanan.");
    }
});

// Update Status Pembayaran
app.post('/pesanan/status/:id', isAuthenticated, async (req, res) => {
    const { status_bayar } = req.body;
    try {
        await db.query('UPDATE pesanan SET status_bayar = ? WHERE id = ? AND user_id = ?', [status_bayar, req.params.id, req.session.userId]);
        res.redirect('/manage-pesanan?status=updatesuccess');
    } catch (err) {
        res.redirect('/manage-pesanan?status=updatefailed');
    }
});

// Update Data Item Pesanan & Catatan Textarea
app.post('/pesanan/update/:id', isAuthenticated, async (req, res) => {
    const { jumlah_kue, rasa, ukuran, tanggal_kirim, pesanan_id, catatan } = req.body;
    try {
        await db.query('UPDATE pesanan SET tanggal_kirim = ?, catatan = ? WHERE id = ? AND user_id = ?', [tanggal_kirim, catatan, pesanan_id, req.session.userId]);
        await db.query(
            'UPDATE pesanan_detail SET jumlah_kue = ?, rasa = ?, ukuran = ? WHERE id = ?',
            [jumlah_kue, rasa, ukuran, req.params.id]
        );
        res.redirect('/manage-pesanan?status=updatesuccess');
    } catch (err) {
        console.error("🔥 Gagal memperbarui rincian pesanan:", err);
        res.redirect('/manage-pesanan?status=updatefailed');
    }
});

// Hapus Pesanan
app.get('/pesanan/delete/:id', isAuthenticated, async (req, res) => {
    try {
        await db.query(`
            DELETE pd FROM pesanan_detail pd
            JOIN pesanan p ON pd.pesanan_id = p.id
            WHERE pd.id = ? AND p.user_id = ?
        `, [req.params.id, req.session.userId]);
        res.redirect('/manage-pesanan?status=deletesuccess');
    } catch (err) {
        res.redirect('/manage-pesanan?status=deletefailed');
    }
});

// 4. History Pesanan & Produksi Terkelompok
app.get('/history', isAuthenticated, async (req, res) => {
    const filterTanggal = req.query.tanggal || '';
    const cariNama = req.query.nama || '';
    try {
        let paramsOrders = [req.session.userId];
        let paramsProduksi = [req.session.userId];
        
        let queryOrders = `
            SELECT p.id AS pesanan_id, p.nama_pemesan, p.tanggal_kirim, p.status_bayar, p.catatan,
                   pd.id AS detail_id, pd.jumlah_kue, pd.rasa, pd.ukuran, pd.is_frozen
            FROM pesanan p
            JOIN pesanan_detail pd ON p.id = pd.pesanan_id
            WHERE p.user_id = ?`;
            
        let queryProduksi = `SELECT id, jumlah_kg, jumlah_kue, rasa, ukuran, tanggal_produksi FROM_SET produksi WHERE user_id = ?`;
        let queryProduksiFix = queryProduksi.replace('FROM_SET', 'FROM');

        if (cariNama) {
            queryOrders += ' AND p.nama_pemesan LIKE ?';
            paramsOrders.push(`%${cariNama}%`);
        }

        if (filterTanggal) {
            queryOrders += ' AND p.tanggal_kirim = ?';
            queryProduksiFix += ' AND tanggal_produksi = ?';
            paramsOrders.push(filterTanggal);
            paramsProduksi.push(filterTanggal);
        }
        
        queryOrders += ' ORDER BY p.tanggal_kirim DESC, p.nama_pemesan ASC';
        queryProduksiFix += ' ORDER BY tanggal_produksi DESC, jumlah_kg DESC';
        
        const [rowsOrders] = await db.query(queryOrders, paramsOrders);
        const [rowsProduksi] = await db.query(queryProduksiFix, paramsProduksi);
        
        const groupedOrdersMap = {};
        rowsOrders.forEach(row => {
            const tglString = new Date(row.tanggal_kirim).toLocaleDateString('fr-CA');
            const uniqueKey = `${row.nama_pemesan.trim().toLowerCase()}_${tglString}`;
            
            if (!groupedOrdersMap[uniqueKey]) {
                groupedOrdersMap[uniqueKey] = {
                    nama_pemesan: row.nama_pemesan,
                    tanggal_kirim: row.tanggal_kirim,
                    status_bayar: row.status_bayar,
                    catatan: row.catatan,
                    details: []
                };
            }
            groupedOrdersMap[uniqueKey].details.push({
                jumlah_kue: row.jumlah_kue,
                rasa: row.rasa,
                ukuran: row.ukuran,
                is_frozen: row.is_frozen
            });
        });
        const orders = Object.values(groupedOrdersMap);

        const groupedProduksiMap = {};
        rowsProduksi.forEach(row => {
            const tglString = new Date(row.tanggal_produksi).toLocaleDateString('fr-CA');
            const uniqueKey = `${tglString}_${parseFloat(row.jumlah_kg).toFixed(2)}`;
            
            if (!groupedProduksiMap[uniqueKey]) {
                groupedProduksiMap[uniqueKey] = {
                    jumlah_kg: row.jumlah_kg,
                    tanggal_produksi: row.tanggal_produksi,
                    details: []
                };
            }
            groupedProduksiMap[uniqueKey].details.push({
                jumlah_kue: row.jumlah_kue,
                rasa: row.rasa,
                ukuran: row.ukuran
            });
        });
        const productions = Object.values(groupedProduksiMap);
        
        res.render('history', { orders, productions, filterTanggal, cariNama });
    } catch (err) {
        console.error("🔥 Gagal memuat data histori log:", err);
        res.status(500).send("Gagal mengambil data riwayat log.");
    }
});

// 5. Menu Profile Informasi & Logout
app.get('/profile', isAuthenticated, (req, res) => {
    res.render('profile');
});

// Server Initialization
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});