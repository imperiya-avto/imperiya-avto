const express = require('express');
const path = require('path');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

// ================= НАСТРОЙКИ =================
// ЗАМЕНИТЕ ЭТО НА ВАШ ЛОГИН, ПОД КОТОРЫМ ВЫ ЗАХОДИТЕ В ИГРУ!
const ADMIN_LOGIN = 'YOUR_ADMIN_LOGIN'; 

// Строка подключения к базе данных (если вы меняли пароль в MongoDB, замените его здесь)
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://q1weshgg5_db_user:RFWAVljQWN6vqJ3@cluster0.kndazx5.mongodb.net/?retryWrites=true&w=majority';
const DB_NAME = 'imperiya_avto';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db;

// Подключение к MongoDB
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

// Регистрация
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
      balance: 400000,
      income: 0,
      cars: [{ id: 'rusty_7' }],
      garageSlots: 5,
      fuel: 20,
      lastFuelTime: Date.now(),
      lastTime: Date.now()
    },
    friends: [],
    friendRequests: []
  };

  await users.insertOne(newUser);
  res.json({ success: true, user: newUser });
});

// Вход
app.post('/api/login', async (req, res) => {
  const { login, password } = req.body;
  const user = await db.collection('users').findOne({ login });
  if (!user) return res.status(400).json({ error: 'Пользователь не найден!' });
  if (user.password !== password) return res.status(400).json({ error: 'Неверный пароль!' });
  res.json({ success: true, user });
});

// Сохранение
app.post('/api/save', async (req, res) => {
  const { login, gameData } = req.body;
  await db.collection('users').updateOne({ login }, { $set: { gameData } });
  res.json({ success: true });
});

// Топ
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

// Получить пользователя
app.get('/api/user/:login', async (req, res) => {
  const user = await db.collection('users').findOne({ login: req.params.login });
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json(user);
});

// Профиль
app.post('/api/profile', async (req, res) => {
  const { login, profile } = req.body;
  await db.collection('users').updateOne({ login }, { $set: { profile } });
  res.json({ success: true });
});

// ================= АДМИН ПАНЕЛЬ (ВЫДАЧА ДЕНЕГ) =================
app.post('/api/admin/give', async (req, res) => {
  try {
    const { adminLogin, targetId, amount } = req.body;
    
    // Проверка, что запрос делает именно админ
    if (adminLogin !== ADMIN_LOGIN) {
      return res.status(403).json({ error: 'У вас нет прав администратора!' });
    }

    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'Неверная сумма!' });
    }

    // Ищем игрока по ID в базе данных
    const user = await db.collection('users').findOne({ playerId: targetId });
    if (!user) {
      return res.status(404).json({ error: 'Игрок с таким ID не найден!' });
    }

    // Начисляем деньги
    const newBalance = (user.gameData.balance || 0) + numAmount;
    await db.collection('users').updateOne(
      { playerId: targetId },
      { $set: { 'gameData.balance': newBalance } }
    );

    console.log(`Админ выдал ${numAmount} игроку ${targetId}. Новый баланс: ${newBalance}`);
    res.json({ success: true, newBalance });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
