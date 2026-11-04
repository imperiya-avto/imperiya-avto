const express = require('express');
const path = require('path');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_LOGIN = 'Q1wesh'; 
const MAX_FUEL = 10; 

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://q1weshgg5_db_user:RFWAVljQWN6vqJ3@cluster0.kndazx5.mongodb.net/?retryWrites=true&w=majority';
const DB_NAME = 'imperiya_avto';

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
    console.error('❌ Ошибка подключения:', err);
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
      fuel: 10,
      lastFuelTime: Date.now(),
      lastTime: Date.now(),
      myNumbers: [],
      numbersSlots: 10,
      collectionCars: [], // НОВОЕ ПОЛЕ: Машины для коллекции
      collectionBonusApplied: false // НОВОЕ ПОЛЕ: Флаг бонуса коллекции
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

app.post('/api/admin/adjust', async (req, res) => {
  try {
    const { adminLogin, targetId, amount } = req.body;
    if (adminLogin !== ADMIN_LOGIN) return res.status(403).json({ error: 'Нет прав администратора!' });

    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount === 0) return res.status(400).json({ error: 'Неверная сумма!' });

    let user = await db.collection('users').findOne({ playerId: targetId });
    if (!user) user = await db.collection('users').findOne({ login: targetId });
    if (!user) return res.status(404).json({ error: 'Игрок с таким ID не найден!' });

    const currentBalance = user.gameData.balance || 0;
    const newBalance = Math.max(0, currentBalance + numAmount);

    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { 'gameData.balance': newBalance } }
    );

    res.json({ success: true, newBalance, action: numAmount >= 0 ? 'give' : 'take' });
  } catch (e) {
    console.error("Ошибка в админке:", e);
    res.status(500).json({ error: 'Ошибка сервера: ' + e.message });
  }
});
