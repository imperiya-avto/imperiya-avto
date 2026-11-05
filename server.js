'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DB_NAME = process.env.DB_NAME || 'imperiya_avto';
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_LOGIN = String(process.env.ADMIN_LOGIN || '').trim();
if (!ADMIN_LOGIN) console.warn('⚠️ ADMIN_LOGIN не задан: админ-доступ отключён до настройки переменной окружения.');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUEL = 10;

if (!MONGODB_URI) {
  console.error('❌ Не задан MONGODB_URI. Добавьте строку подключения MongoDB в переменные окружения.');
  process.exit(1);
}

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const publicDir = path.join(__dirname, 'public');
const staticDir = require('fs').existsSync(path.join(publicDir, 'index.html'))
  ? publicDir
  : __dirname;

app.use(express.static(staticDir, { index: 'index.html' }));

let db;
const sessions = new Map();
const authAttempts = new Map();

function cleanLogin(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeUser(user) {
  if (!user) return null;
  const { password, passwordHash, ...publicData } = user;
  return { ...publicData, isAdmin: Boolean(ADMIN_LOGIN) && String(user.login || '').toLowerCase() === ADMIN_LOGIN.toLowerCase() };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, stored) {
  if (!stored || !stored.salt || !stored.hash) return false;

  const candidate = crypto.scryptSync(password, stored.salt, 64);
  const expected = Buffer.from(stored.hash, 'hex');

  return candidate.length === expected.length &&
    crypto.timingSafeEqual(candidate, expected);
}

function rateLimit(req, res, next) {
  const key = `${req.ip}:${req.path}`;
  const now = Date.now();

  const entry = authAttempts.get(key) || {
    count: 0,
    until: now + 10 * 60 * 1000
  };

  if (entry.until <= now) {
    entry.count = 0;
    entry.until = now + 10 * 60 * 1000;
  }

  entry.count++;
  authAttempts.set(key, entry);

  if (entry.count > 30) {
    return res.status(429).json({
      error: 'Слишком много попыток. Попробуйте позже.'
    });
  }

  next();
}

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '');

  const session = sessions.get(token);

  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);

    return res.status(401).json({
      error: 'Сессия истекла. Войдите снова.'
    });
  }

  req.userLogin = session.login;
  req.isAdmin = Boolean(ADMIN_LOGIN) && session.login.toLowerCase() === ADMIN_LOGIN.toLowerCase();

  next();
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({
      error: 'Нет прав администратора!'
    });
  }

  next();
}

function issueSession(login) {
  const token = crypto.randomBytes(32).toString('hex');

  sessions.set(token, {
    login,
    expiresAt: Date.now() + SESSION_TTL_MS
  });

  return token;
}

function validProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return null;
  }

  const name = String(profile.name || '').trim().slice(0, 32);
  const bio = String(profile.bio || '').trim().slice(0, 240);

  const avatar =
    typeof profile.avatar === 'string' &&
    profile.avatar.length <= 500000
      ? profile.avatar
      : '';

  if (avatar && !/^data:image\/(png|jpeg|webp|gif);base64,/i.test(avatar)) {
    return null;
  }

  return { name, bio, avatar };
}

// РЕГИСТРАЦИЯ
app.post('/api/register', rateLimit, async (req, res) => {
  const login = cleanLogin(req.body.login);

  const password =
    typeof req.body.password === 'string'
      ? req.body.password
      : '';

  if (
    !/^[\p{L}\p{N}_-]{3,24}$/u.test(login) ||
    password.length < 8 ||
    password.length > 128
  ) {
    return res.status(400).json({
      error: 'Логин: 3–24 символа (буквы, цифры, _ или -). Пароль: минимум 8 символов.'
    });
  }

  if (login.toLowerCase() === ADMIN_LOGIN.toLowerCase()) {
    return res.status(403).json({
      error: 'Этот логин зарезервирован.'
    });
  }

  const users = db.collection('users');

  if (await users.findOne({ login })) {
    return res.status(409).json({
      error: 'Логин занят!'
    });
  }

  // Random player ID prevents collisions after deletion/concurrent registrations.
  let playerId;
  for (let attempt = 0; attempt < 10; attempt++) {
    const digits = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const candidate = `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`;
    if (!(await users.findOne({ playerId: candidate }))) { playerId = candidate; break; }
  }
  if (!playerId) return res.status(503).json({ error: 'Не удалось создать ID. Повторите регистрацию.' });

  const passwordData = hashPassword(password);

  const user = {
    login,
    passwordHash: passwordData,
    playerId,

    profile: {
      name: login,
      bio: '',
      avatar: ''
    },

    gameData: {
      balance: 350000,
      income: 0,
      cars: [{ id: 'rusty_7' }],
      garageSlots: 5,
      fuel: MAX_FUEL,
      lastFuelTime: Date.now(),
      lastTime: Date.now(),
      myNumbers: [],
      numbersSlots: 10,
      collectionCars: [],
      collectionBonusApplied: false
    },

    friends: [],
    friendRequests: []
  };

  await users.insertOne(user);

  const token = issueSession(login);

  res.json({
    success: true,
    token,
    user: safeUser(user)
  });
});

// ВХОД
app.post('/api/login', rateLimit, async (req, res) => {
  const login = cleanLogin(req.body.login);

  const password =
    typeof req.body.password === 'string'
      ? req.body.password
      : '';

  const users = db.collection('users');
  const user = await users.findOne({ login });

  if (!user) {
    return res.status(400).json({
      error: 'Неверный логин или пароль.'
    });
  }

  let valid = false;

  if (user.passwordHash) {
    valid = verifyPassword(password, user.passwordHash);
  } else if (typeof user.password === 'string') {
    const a = Buffer.from(password);
    const b = Buffer.from(user.password);

    valid =
      a.length === b.length &&
      crypto.timingSafeEqual(a, b);

    if (valid) {
      const passwordData = hashPassword(password);

      await users.updateOne(
        { _id: user._id },
        {
          $set: { passwordHash: passwordData },
          $unset: { password: '' }
        }
      );

      user.passwordHash = passwordData;
      delete user.password;
    }
  }

  if (!valid) {
    return res.status(400).json({
      error: 'Неверный логин или пароль.'
    });
  }

  const token = issueSession(login);

  res.json({
    success: true,
    token,
    user: safeUser(user)
  });
});

// ПОЛУЧЕНИЕ СВОЕГО ПРОФИЛЯ
app.get('/api/me', requireAuth, async (req, res) => {
  const user = await db.collection('users').findOne({
    login: req.userLogin
  });

  if (!user) {
    return res.status(404).json({
      error: 'Пользователь не найден.'
    });
  }

  res.json(safeUser(user));
});

// ВЫХОД
app.post('/api/logout', requireAuth, (req, res) => {
  const token = (req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '');

  sessions.delete(token);

  res.json({ success: true });
});

// СОХРАНЕНИЕ ИГРЫ
app.post('/api/save', requireAuth, async (req, res) => {
  const gameData = req.body.gameData;

  if (
    !gameData ||
    typeof gameData !== 'object' ||
    Array.isArray(gameData)
  ) {
    return res.status(400).json({
      error: 'Некорректные игровые данные.'
    });
  }

  const allowed = [
    'balance',
    'income',
    'cars',
    'garageSlots',
    'fuel',
    'lastFuelTime',
    'lastTime',
    'myNumbers',
    'numbersSlots',
    'tasksData',
    'tasksResetTime',
    'pityLetters',
    'pityDigits',
    'collectionBonusApplied',
    'collectionCars',
    'xp',
    'playTimeCounter'
  ];

  const update = {};

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(gameData, key)) {
      update[`gameData.${key}`] = gameData[key];
    }
  }

  if (typeof update['gameData.balance'] !== 'undefined') {
    const value = Number(update['gameData.balance']);
    if (!Number.isFinite(value) || value < 0 || value > 1e15) return res.status(400).json({ error: 'Некорректный баланс.' });
    update['gameData.balance'] = Math.floor(value);
  }

  if (typeof update['gameData.income'] !== 'undefined') {
    const value = Number(update['gameData.income']);
    if (!Number.isFinite(value) || value < 0 || value > 1e12) return res.status(400).json({ error: 'Некорректный доход.' });
    update['gameData.income'] = value;
  }
  for (const key of ['fuel','garageSlots','numbersSlots','xp','playTimeCounter','pityLetters','pityDigits']) {
    const field = `gameData.${key}`;
    if (typeof update[field] !== 'undefined') {
      const value = Number(update[field]);
      if (!Number.isFinite(value) || value < 0 || value > 1e12) return res.status(400).json({ error: `Некорректное поле ${key}.` });
      update[field] = Math.floor(value);
    }
  }
  for (const key of ['myNumbers','tasksData','collectionCars']) {
    const field = `gameData.${key}`;
    if (typeof update[field] !== 'undefined' && (!Array.isArray(update[field]) || update[field].length > 5000)) return res.status(400).json({ error: `Некорректное поле ${key}.` });
  }

  if (typeof update['gameData.cars'] !== 'undefined') {
    const list = update['gameData.cars'];
    if (!Array.isArray(list) || list.length > 1000 || list.some(c => !c || typeof c !== 'object' || typeof c.id !== 'string' || c.id.length > 100)) return res.status(400).json({ error: 'Некорректный список машин.' });
    update['gameData.cars'] = list.map(c => {
      const t = c.tuning && typeof c.tuning === 'object' ? c.tuning : {};
      return { ...c, tuning: { engine: Math.min(5, Math.max(0, Math.floor(Number(t.engine) || 0))), turbo: Math.min(4, Math.max(0, Math.floor(Number(t.turbo) || 0))), suspension: Math.min(3, Math.max(0, Math.floor(Number(t.suspension) || 0))) } };
    });
  }

  if (Object.keys(update).length) {
    await db.collection('users').updateOne(
      { login: req.userLogin },
      { $set: update }
    );
  }

  res.json({ success: true });
});

// РЕЙТИНГ ИГРОКОВ
app.get('/api/top', async (req, res) => {
  const players = await db.collection('users')
    .find(
      {},
      {
        projection: {
          login: 1,
          playerId: 1,
          profile: 1,
          'gameData.balance': 1
        }
      }
    )
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

// ПОЛУЧЕНИЕ ПРОФИЛЯ ИГРОКА
app.get('/api/user/:login', async (req, res) => {
  const user = await db.collection('users').findOne(
    { login: req.params.login },
    {
      projection: {
        login: 1,
        playerId: 1,
        profile: 1,
        gameData: 1
      }
    }
  );

  if (!user) {
    return res.status(404).json({
      error: 'Не найден'
    });
  }

  const token = (req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '');

  const isOwner =
    sessions.get(token)?.login === user.login;

  if (!isOwner) {
    const publicGameData = {
      cars: (user.gameData?.cars || []).map(c => ({
        id: c.id,
        plate: c.plate || null
      })),
      lastTime: user.gameData?.lastTime || null
    };

    return res.json({
      login: user.login,
      playerId: user.playerId,
      profile: user.profile || {},
      gameData: publicGameData
    });
  }

  res.json(safeUser(user));
});

// ИЗМЕНЕНИЕ ПРОФИЛЯ
app.post('/api/profile', requireAuth, async (req, res) => {
  const profile = validProfile(req.body.profile);

  if (!profile) {
    return res.status(400).json({
      error: 'Некорректный профиль или аватар.'
    });
  }

  await db.collection('users').updateOne(
    { login: req.userLogin },
    { $set: { profile } }
  );

  res.json({ success: true });
});

// АДМИН-ПАНЕЛЬ
app.post(
  '/api/admin/adjust',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const targetId = String(req.body.targetId || '').trim();
    const amount = Number(req.body.amount);

    if (
      !targetId ||
      !Number.isFinite(amount) ||
      amount === 0 ||
      Math.abs(amount) > 1e12
    ) {
      return res.status(400).json({
        error: 'Неверная сумма или ID.'
      });
    }

    let user = await db.collection('users').findOne({
      playerId: targetId
    });

    if (!user) {
      user = await db.collection('users').findOne({
        login: targetId
      });
    }

    if (!user) {
      return res.status(404).json({
        error: 'Игрок с таким ID не найден!'
      });
    }

    const currentBalance =
      Number(user.gameData?.balance) || 0;

    const newBalance =
      Math.max(0, currentBalance + amount);

    await db.collection('users').updateOne(
      { _id: user._id },
      {
        $set: {
          'gameData.balance': newBalance
        }
      }
    );

    res.json({
      success: true,
      newBalance,
      action: amount >= 0 ? 'give' : 'take'
    });
  }
);

// ОБРАБОТКА ОШИБОК
app.use((err, req, res, next) => {
  console.error('API error:', err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    error: 'Внутренняя ошибка сервера.'
  });
});

// ЗАПУСК СЕРВЕРА
MongoClient.connect(MONGODB_URI)
  .then(async client => {
    db = client.db(DB_NAME);
    await db.collection('users').createIndex({ login: 1 }, { unique: true });
    await db.collection('users').createIndex({ playerId: 1 }, { unique: true, sparse: true });

    app.listen(PORT, () => {
      console.log(`✅ Сервер запущен на порту ${PORT}`);
    });
  })
  .catch(err => {
    console.error(
      '❌ Ошибка подключения к MongoDB:',
      err.message
    );

    process.exit(1);
  });
