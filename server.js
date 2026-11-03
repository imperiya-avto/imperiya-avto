const express = require('express');
const path = require('path');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'imperiya_avto';
const MAX_FUEL = 10;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db;

MongoClient.connect(MONGODB_URI)
  .then(client => {
    console.log('✅ Подключено к MongoDB');
    db = client.db(DB_NAME);
    app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}`));
  })
  .catch(err => {
    console.error('❌ Ошибка подключения к базе данных:', err);
    process.exit(1);
  });

app.post('/api/register', async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Заполните поля!' });

  const users = db.collection('users');
  const existing = await users.findOne({ login });
  if (existing) return res.status(400).json({ error: 'Логин занят!' });

  const count = await users.countDocuments();
  const num = (count + 1) * 10;
  const str = String(num).padStart(6, '0');
  const playerId = str.slice(0, 2) + '-' + str.slice(2, 4) + '-' + str.slice(4, 6);

  const newUser = {
    login,
    password,
    playerId,
    profile: { name: login, bio: '', avatar: '' },
    gameData: {
      balance: 350000,
      income: 0,
      cars: [{ id: 'rusty_7' }],
      garageSlots: 5,
      fuel: MAX_FUEL,
      lastFuelTime: Date.now(),
      lastTime: Date.now()
    },
    friends: [],
    friendRequests: []
  };

  await users.insertOne(newUser);
  res.json({ success: true, user: newUser });
});

app.post('/api/login', async (req, res) => {
  const { login, password } = req.body;
  const user = await db.collection('users').findOne({ login });
  if (!user) return res.status(400).json({ error: 'Пользователь не найден!' });
  if (user.password !== password) return res.status(400).json({ error: 'Неверный пароль!' });
  res.json({ success: true, user });
});

app.post('/api/save', async (req, res) => {
  const { login, gameData } = req.body;
  if (gameData && typeof gameData.fuel === 'number' && gameData.fuel > MAX_FUEL) {
    gameData.fuel = MAX_FUEL;
  }
  await db.collection('users').updateOne({ login }, { $set: { gameData } });
  res.json({ success: true });
});

app.get('/api/top', async (req, res) => {
  const players = await db.collection('users')
    .find({}, { projection: { login: 1, playerId: 1, profile: 1, 'gameData.balance': 1 } })
    .sort({ 'gameData.balance': -1 })
    .limit(200)
    .toArray();

  res.json(players.map(p => ({
    login: p.login,
    playerId: p.playerId,
    name: p.profile?.name || p.login,
    avatar: p.profile?.avatar || '',
    balance: p.gameData?.balance || 0
  })));
});

app.get('/api/user/:login', async (req, res) => {
  const user = await db.collection('users').findOne({ login: req.params.login });
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json(user);
});

app.post('/api/profile', async (req, res) => {
  const { login, profile } = req.body;
  await db.collection('users').updateOne({ login }, { $set: { profile } });
  res.json({ success: true });
});

// ================= АДМИН ПАНЕЛЬ =================
app.post('/api/admin/money', async (req, res) => {
  const { adminLogin, targetPlayerId, amount, action } = req.body;

  console.log(`[ADMIN] Запрос от ${adminLogin}: ${action} ${amount} для ID: ${targetPlayerId}`);

  if (adminLogin !== 'Q1wesh') {
    return res.status(403).json({ error: 'Доступ запрещен. Вы не администратор.' });
  }

  try {
    let targetUser = await db.collection('users').findOne({ playerId: targetPlayerId });

    if (!targetUser) {
      targetUser = await db.collection('users').findOne({ login: targetPlayerId });
    }

    if (!targetUser) {
      return res.status(404).json({ error: `Игрок с ID/Логином "${targetPlayerId}" не найден в базе!` });
    }

    let currentBalance = targetUser.gameData?.balance || 0;
    let newBalance = currentBalance;
    const numericAmount = Number(amount);

    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: 'Неверная сумма!' });
    }

    if (action === 'add') {
      newBalance += numericAmount;
    } else if (action === 'take') {
      newBalance -= numericAmount;
      if (newBalance < 0) newBalance = 0;
    }

    await db.collection('users').updateOne(
      { _id: targetUser._id },
      { $set: { 'gameData.balance': newBalance } }
    );

    console.log(`[ADMIN] Успех! Новый баланс ${targetUser.login}: ${newBalance}`);
    res.json({ success: true, newBalance, targetLogin: targetUser.login });

  } catch (err) {
    console.error('[ADMIN] ОШИБКА:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера: ' + err.message });
  }
});
