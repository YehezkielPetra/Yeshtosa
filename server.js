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
app.use((req, res, next) => {
    res.locals.username = req.session.username || null;
    res.locals.email = req.session.email || null;
    res.locals.status = req.query.status || null; // Menangkap status secara global untuk pop-up modal kustom
    next();
});

// ================= ROUTING AUTENTIKASI =================

app.get('/login', (req, res) => {
    try {
        if (req.session.userId) return res.redirect('/dashboard');
        res.render('login');
    } catch (error) {
        // Memaksa Render mencetak error rendering ejs jika ada masalah path folder
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
        // Memaksa Render mencetak error database secara detail di tab Logs
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

app.get('/dashboard', isAuthenticated, (req, res) => {
    res.render('dashboard');
});

// 1. Input Jumlah Produksi (Masak - Mendukung Banyak Baris/Multi-Item)
app.get('/produksi', isAuthenticated, (req, res) => {
    res.render('produksi');
});

app.post('/produksi', isAuthenticated, async (req, res) => {
    const { jumlah_kg, jumlah_kue, rasa, ukuran, tanggal_produksi } = req.body;
    try {
        // Normalisasi data ke bentuk array untuk mengantisipasi input tunggal maupun jamak
        const itemsKg = Array.isArray(jumlah_kg) ? jumlah_kg : [jumlah_kg];
        const itemsQty = Array.isArray(jumlah_kue) ? jumlah_kue : [jumlah_kue];
        const itemsRasa = Array.isArray(rasa) ? rasa : [rasa];
        const itemsUkuran = Array.isArray(ukuran) ? ukuran : [ukuran];

        // Eksekusi bulk-insert rencana adonan masakan ke database
        for (let i = 0; i < itemsKg.length; i++) {
            await db.query(
                'INSERT INTO produksi (user_id, jumlah_kg, jumlah_kue, rasa, ukuran, tanggal_produksi) VALUES (?, ?, ?, ?, ?, ?)',
                [req.session.userId, itemsKg[i], itemsQty[i], itemsRasa[i], itemsUkuran[i], tanggal_produksi]
            );
        }
        res.redirect('/produksi?status=produksuccess');
    } catch (err) {
        res.redirect('/produksi?status=produksifailed');
    }
});

// 2. Input Pesanan Masuk (Mendukung Multi-Rasa dan Multi-Ukuran sekaligus)
app.get('/pesanan', isAuthenticated, (req, res) => {
    res.render('pesanan');
});

app.post('/pesanan', isAuthenticated, async (req, res) => {
    const { nama_pemesan, tanggal_kirim, jumlah_kue, rasa, ukuran, is_frozen } = req.body;
    try {
        // A. Insert data entitas induk pesanan (Master)
        const [resultMaster] = await db.query(
            'INSERT INTO pesanan (nama_pemesan, tanggal_kirim) VALUES (?, ?)',
            [nama_pemesan, tanggal_kirim]
        );
        const insertIdMaster = resultMaster.insertId;

        // B. Normalisasi data rincian kue menjadi array
        const itemsQty = Array.isArray(jumlah_kue) ? jumlah_kue : [jumlah_kue];
        const itemsRasa = Array.isArray(rasa) ? rasa : [rasa];
        const itemsUkuran = Array.isArray(ukuran) ? ukuran : [ukuran];
        const itemsFrozen = Array.isArray(is_frozen) ? is_frozen : [is_frozen];

        // C. Eksekusi penyimpanan baris rincian item ke tabel detail
        for (let i = 0; i < itemsQty.length; i++) {
            const frozenVal = itemsFrozen[i] === '1' ? 1 : 0;
            await db.query(
                'INSERT INTO pesanan_detail (pesanan_id, jumlah_kue, rasa, ukuran, is_frozen) VALUES (?, ?, ?, ?, ?)',
                [insertIdMaster, itemsQty[i], itemsRasa[i], itemsUkuran[i], frozenVal]
            );
        }
        res.redirect('/pesanan?status=pesanansuccess');
    } catch (err) {
        res.redirect('/pesanan?status=pesananfailed');
    }
});

// 3. Manage Pesanan & CRUD (Menggunakan JOIN antara Master & Detail)
app.get('/manage-pesanan', isAuthenticated, async (req, res) => {
    try {
        const [orders] = await db.query(`
            SELECT p.id, p.nama_pemesan, p.tanggal_kirim, p.status_bayar,
                   pd.id AS detail_id, pd.jumlah_kue, pd.rasa, pd.ukuran, pd.is_frozen
            FROM pesanan p
            JOIN pesanan_detail pd ON p.id = pd.pesanan_id
            ORDER BY p.tanggal_kirim ASC, p.id ASC
        `);
        res.render('manage-pesanan', { orders });
    } catch (err) {
        res.status(500).send("Gagal mengambil data pesanan.");
    }
});

// Update Status Pembayaran (Berdasarkan ID Master Pesanan)
app.post('/pesanan/status/:id', isAuthenticated, async (req, res) => {
    const { status_bayar } = req.body;
    try {
        await db.query('UPDATE pesanan SET status_bayar = ? WHERE id = ?', [status_bayar, req.params.id]);
        res.redirect('/manage-pesanan?status=updatesuccess');
    } catch (err) {
        res.redirect('/manage-pesanan?status=updatefailed');
    }
});

// Update Data Item Pesanan (CRUD - Edit Berdasarkan ID Detail Rincian Kue)
app.post('/pesanan/update/:id', isAuthenticated, async (req, res) => {
    const { jumlah_kue, rasa, ukuran, tanggal_kirim, pesanan_id } = req.body;
    try {
        // A. Perbarui tanggal kirim pada entitas induk pesanan
        await db.query('UPDATE pesanan SET tanggal_kirim = ? WHERE id = ?', [tanggal_kirim, pesanan_id]);
        
        // B. Perbarui rincian adonan porsi spesifik pada tabel detail
        await db.query(
            'UPDATE pesanan_detail SET jumlah_kue = ?, rasa = ?, ukuran = ? WHERE id = ?',
            [jumlah_kue, rasa, ukuran, req.params.id]
        );
        res.redirect('/manage-pesanan?status=updatesuccess');
    } catch (err) {
        res.redirect('/manage-pesanan?status=updatefailed');
    }
});

// Hapus Pesanan (CRUD - Delete Berdasarkan ID Detail Rincian Kue)
app.get('/pesanan/delete/:id', isAuthenticated, async (req, res) => {
    try {
        await db.query('DELETE FROM pesanan_detail WHERE id = ?', [req.params.id]);
        res.redirect('/manage-pesanan?status=deletesuccess');
    } catch (err) {
        res.redirect('/manage-pesanan?status=deletefailed');
    }
});

// 4. History Pesanan dengan Filter Tanggal Hari (JOIN View Komplet)
app.get('/history', isAuthenticated, async (req, res) => {
    const filterTanggal = req.query.tanggal || '';
    try {
        let query = `
            SELECT p.nama_pemesan, p.tanggal_kirim, p.status_bayar, 
                   pd.jumlah_kue, pd.rasa, pd.ukuran, pd.is_frozen
            FROM pesanan p
            JOIN pesanan_detail pd ON p.id = pd.pesanan_id`;
        let params = [];
        
        if (filterTanggal) {
            query += ' WHERE p.tanggal_kirim = ?';
            params.push(filterTanggal);
        }
        query += ' ORDER BY p.tanggal_kirim DESC';
        
        const [orders] = await db.query(query, params);
        res.render('history', { orders, filterTanggal });
    } catch (err) {
        res.status(500).send("Gagal mengambil data riwayat.");
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