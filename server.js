const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs'); // Menggunakan bcryptjs agar aman dan lancar di Windows
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
app.use(async (req, res, next) => {
    res.locals.username = req.session.username || null;
    res.locals.email = req.session.email || null;
    res.locals.status = req.query.status || null;
    res.locals.last_device = req.query.last_device || null;
    res.locals.last_time = req.query.last_time || null;

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
    const userAgent = req.headers['user-agent'] || 'Unknown Device';
    
    let deviceName = 'Komputer / PC';
    if (/mobile/i.test(userAgent)) deviceName = 'Smartphone / HP';
    if (/tablet/i.test(userAgent)) deviceName = 'Tablet';

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

        // PENGHAPUSAN VALIDASI DEVICE TUNGGAL: Akun kini bebas login di mana saja
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.email = user.email;

        // Tetap mencatat info metadata device login terakhir untuk arsip dashboard tanpa memblokir
        await db.query(
            'UPDATE users SET is_active_session = ?, last_device = ?, last_login_at = NOW() WHERE id = ?',
            [req.sessionID, deviceName, user.id]
        );

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
        await db.query('INSERT INTO users (username, email, password, harga_kecil, harga_besar, harga_jumbo) VALUES (?, ?, ?, 0, 0, 0)', [username, email, hashedPassword]);
        res.redirect('/login?status=registersuccess');
    } catch (err) {
        res.redirect('/register?status=registerfailed');
    }
});

app.get('/logout', async (req, res) => {
    try {
        if (req.session.userId) {
            await db.query('UPDATE users SET is_active_session = NULL WHERE id = ?', [req.session.userId]);
        }
    } catch (err) {
        console.error("🔥 Gagal mereset sesi database saat logout:", err);
    }
    req.session.destroy(() => {
        res.redirect('/login?status=logoutsuccess');
    });
});

// ================= RUTE INTERNAL ADMIN (PROTECTED) =================

app.get('/', isAuthenticated, (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', isAuthenticated, async (req, res) => {
    try {
        const [stokKue] = await db.query('SELECT rasa, ukuran, stok_sekarang FROM stok_kue ORDER BY rasa ASC, ukuran ASC');
        const [userProfile] = await db.query('SELECT last_device, last_login_at FROM users WHERE id = ?', [req.session.userId]);
        res.render('dashboard', { stokKue, profile: userProfile[0] || {} });
    } catch (err) {
        console.error("🔥 Gagal memuat ringkasan stok di dashboard:", err);
        res.status(500).send("Gagal memuat halaman dashboard.");
    }
});

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
    const connection = await db.getConnection(); 
    try {
        await connection.beginTransaction();

        const itemsQty = Array.isArray(jumlah_kue) ? jumlah_kue : [jumlah_kue];
        const itemsRasa = Array.isArray(rasa) ? rasa : [rasa];
        const itemsUkuran = Array.isArray(ukuran) ? ukuran : [ukuran];

        for (let i = 0; i < itemsQty.length; i++) {
            const qty = parseInt(itemsQty[i]);
            const rsa = itemsRasa[i];
            const ukr = itemsUkuran[i];

            await connection.query(
                'INSERT INTO produksi (user_id, jumlah_kg, jumlah_kue, rasa, ukuran, tanggal_produksi) VALUES (?, ?, ?, ?, ?, ?)',
                [req.session.userId, jumlah_kg, qty, rsa, ukr, tanggal_produksi]
            );

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

app.get('/produksi/delete/:id', isAuthenticated, async (req, res) => {
    try {
        await db.query('DELETE FROM_SET produksi WHERE id = ? AND user_id = ?'.replace('FROM_SET', 'FROM'), [req.params.id, req.session.userId]);
        res.redirect('/produksi?status=deletesuccess');
    } catch (err) {
        console.error("🔥 Gagal menghapus data produksi:", err);
        res.redirect('/produksi?status=deletefailed');
    }
});

app.get('/pesanan', isAuthenticated, (req, res) => {
    res.render('pesanan');
});

app.post('/pesanan', isAuthenticated, async (req, res) => {
    const { nama_pemesan, tanggal_kirim, jam_kirim, jumlah_kue, rasa, ukuran, is_frozen, tipe_pesanan, harga_kustom } = req.body;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const itemsQty = Array.isArray(jumlah_kue) ? jumlah_kue : [jumlah_kue];
        const itemsRasa = Array.isArray(rasa) ? rasa : [rasa];
        const itemsUkuran = Array.isArray(ukuran) ? ukuran : [ukuran];
        const itemsFrozen = Array.isArray(is_frozen) ? is_frozen : [is_frozen];
        const itemsTipe = Array.isArray(tipe_pesanan) ? tipe_pesanan : [tipe_pesanan];
        const itemsHargaKustom = Array.isArray(harga_kustom) ? harga_kustom : [harga_kustom];

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
                await connection.rollback();
                return res.redirect('/pesanan?status=stockinsufficient');
            }
        }

        const [resultMaster] = await connection.query(
            'INSERT INTO pesanan (user_id, nama_pemesan, tanggal_kirim, jam_kirim, status_kirim) VALUES (?, ?, ?, ?, \'Diproses\')',
            [req.session.userId, nama_pemesan, tanggal_kirim, jam_kirim]
        );
        const insertIdMaster = resultMaster.insertId;

        for (let i = 0; i < itemsQty.length; i++) {
            const qty = parseInt(itemsQty[i]);
            const rsa = itemsRasa[i];
            const ukr = itemsUkuran[i];
            const frozenVal = itemsFrozen[i] === '1' ? 1 : 0;
            const hrgKustom = itemsTipe[i] === 'Spesial' ? parseInt(itemsHargaKustom[i] || 0) : 0;

            await connection.query(
                'INSERT INTO pesanan_detail (pesanan_id, jumlah_kue, rasa, ukuran, is_frozen, tipe_pesanan, harga_kustom) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [insertIdMaster, qty, rsa, ukr, frozenVal, itemsTipe[i], hrgKustom]
            );

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

app.get('/manage-pesanan', isAuthenticated, async (req, res) => {
    try {
        const [orders] = await db.query(`
            SELECT p.id, p.nama_pemesan, p.tanggal_kirim, p.jam_kirim, p.status_bayar, p.status_kirim, p.catatan,
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

app.post('/pesanan/status-kirim/:id', isAuthenticated, async (req, res) => {
    const { status_kirim } = req.body;
    try {
        if (status_kirim === 'Berhasil Dikirim') {
            await db.query(
                'UPDATE pesanan SET status_kirim = ?, dikirim_pada = NOW() WHERE id = ? AND user_id = ?',
                [status_kirim, req.params.id, req.session.userId]
            );
        } else {
            await db.query(
                'UPDATE pesanan SET status_kirim = ?, dikirim_pada = NULL WHERE id = ? AND user_id = ?',
                [status_kirim, req.params.id, req.session.userId]
            );
        }
        res.redirect('/manage-pesanan?status=updatesuccess');
    } catch (err) {
        console.error("🔥 Gagal mengubah status pengiriman pesanan:", err);
        res.redirect('/manage-pesanan?status=updatefailed');
    }
});

app.post('/pesanan/status/:id', isAuthenticated, async (req, res) => {
    const { status_bayar } = req.body;
    try {
        await db.query('UPDATE pesanan SET status_bayar = ? WHERE id = ? AND user_id = ?', [status_bayar, req.params.id, req.session.userId]);
        res.redirect('/manage-pesanan?status=updatesuccess');
    } catch (err) {
        res.redirect('/manage-pesanan?status=updatefailed');
    }
});

app.post('/pesanan/update/:id', isAuthenticated, async (req, res) => {
    const { jumlah_kue, rasa, ukuran, tanggal_kirim, jam_kirim, pesanan_id, catatan } = req.body;
    try {
        await db.query(
            'UPDATE pesanan SET tanggal_kirim = ?, jam_kirim = ?, catatan = ? WHERE id = ? AND user_id = ?', 
            [tanggal_kirim, jam_kirim, catatan, pesanan_id, req.session.userId]
        );
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

app.get('/history', isAuthenticated, async (req, res) => {
    const filterTanggal = req.query.tanggal || '';
    const cariNama = req.query.nama || '';
    try {
        const [userMeta] = await db.query('SELECT harga_kecil, harga_besar, harga_jumbo FROM users WHERE id = ?', [req.session.userId]);
        const hargaProfil = userMeta[0] || { harga_kecil: 0, harga_besar: 0, harga_jumbo: 0 };

        let paramsOrders = [req.session.userId];
        let paramsProduksi = [req.session.userId];
        
        let queryOrders = `
            SELECT p.id AS pesanan_id, p.nama_pemesan, p.tanggal_kirim, p.jam_kirim, p.status_bayar, p.status_kirim, p.dikirim_pada, p.catatan,
                   pd.id AS detail_id, pd.jumlah_kue, pd.rasa, pd.ukuran, pd.is_frozen, pd.tipe_pesanan, pd.harga_kustom
            FROM pesanan p
            JOIN pesanan_detail pd ON p.id = pd.pesanan_id
            WHERE p.user_id = ?`;
            
        let queryProduksi = `SELECT id, jumlah_kg, jumlah_kue, rasa, ukuran, tanggal_produksi FROM_SET produksi WHERE user_id = ?`.replace('FROM_SET', 'FROM');
        
        if (cariNama) {
            queryOrders += ' AND p.nama_pemesan LIKE ?';
            paramsOrders.push(`%${cariNama}%`);
        }

        if (filterTanggal) {
            queryOrders += ' AND p.tanggal_kirim = ?';
            queryProduksi += ' AND tanggal_produksi = ?';
            paramsOrders.push(filterTanggal);
            paramsProduksi.push(filterTanggal);
        }
        
        queryOrders += ' ORDER BY p.tanggal_kirim DESC, p.nama_pemesan ASC';
        queryProduksi += ' ORDER BY tanggal_produksi DESC, jumlah_kg DESC';
        
        const [rowsOrders] = await db.query(queryOrders, paramsOrders);
        const [rowsProduksi] = await db.query(queryProduksi, paramsProduksi);
        
        const groupedOrdersMap = {};
        rowsOrders.forEach(row => {
            const tglString = new Date(row.tanggal_kirim).toLocaleDateString('fr-CA');
            const uniqueKey = `${row.nama_pemesan.trim().toLowerCase()}_${tglString}`;
            
            if (!groupedOrdersMap[uniqueKey]) {
                groupedOrdersMap[uniqueKey] = {
                    nama_pemesan: row.nama_pemesan,
                    tanggal_kirim: row.tanggal_kirim,
                    jam_kirim: row.jam_kirim,
                    status_bayar: row.status_bayar,
                    status_kirim: row.status_kirim,
                    dikirim_pada: row.dikirim_pada,
                    catatan: row.catatan,
                    total_bayar: 0,
                    details: []
                };
            }

            let hargaPerPcs = 0;
            if (row.tipe_pesanan === 'Spesial') {
                hargaPerPcs = row.harga_kustom;
            } else {
                if (row.ukuran === 'kecil') hargaPerPcs = hargaProfil.harga_kecil;
                else if (row.ukuran === 'besar') hargaPerPcs = hargaProfil.harga_besar;
                else if (row.ukuran === 'jumbo') hargaPerPcs = hargaProfil.harga_jumbo;
            }

            groupedOrdersMap[uniqueKey].total_bayar += (parseInt(row.jumlah_kue) * hargaPerPcs);
            groupedOrdersMap[uniqueKey].details.push({
                jumlah_kue: row.jumlah_kue,
                rasa: row.rasa,
                ukuran: row.ukuran,
                is_frozen: row.is_frozen,
                tipe_pesanan: row.tipe_pesanan
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

app.get('/profile', isAuthenticated, async (req, res) => {
    try {
        const [userMeta] = await db.query('SELECT username, email, harga_kecil, harga_besar, harga_jumbo FROM users WHERE id = ?', [req.session.userId]);
        res.render('profile', { user: userMeta[0] || {} });
    } catch (err) {
        res.status(500).send("Gagal memuat profil admin.");
    }
});

app.post('/profile/update', isAuthenticated, async (req, res) => {
    const { email, password, harga_kecil, harga_besar, harga_jumbo } = req.body;
    try {
        if (password && password.trim() !== "") {
            const hashedPassword = await bcrypt.hash(password, 10);
            await db.query(
                'UPDATE users SET email = ?, password = ?, harga_kecil = ?, harga_besar = ?, harga_jumbo = ? WHERE id = ?',
                [email, hashedPassword, harga_kecil, harga_besar, harga_jumbo, req.session.userId]
            );
        } else {
            await db.query(
                'UPDATE users SET email = ?, harga_kecil = ?, harga_besar = ?, harga_jumbo = ? WHERE id = ?',
                [email, harga_kecil, harga_besar, harga_jumbo, req.session.userId]
            );
        }
        req.session.email = email; 
        res.redirect('/profile?status=updatesuccess');
    } catch (err) {
        console.error("🔥 Gagal memperbarui rincian metadata profil user:", err);
        res.redirect('/profile?status=updatefailed');
    }
});

// Server Initialization
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});