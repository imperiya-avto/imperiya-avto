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
          clanId: 1,
          'gameData.balance': 1
        }
      }
    )
    .sort({ 'gameData.balance': -1 })
    .limit(200)
    .toArray();

  const clanIds = [...new Set(players.map(p => p.clanId).filter(Boolean))];
  const clans = clanIds.length
    ? await db.collection('clans').find({ clanId: { $in: clanIds } }, { projection: { clanId: 1, name: 1 } }).toArray()
    : [];
  const clanNames = new Map(clans.map(c => [c.clanId, c.name]));
  res.json(players.map(p => ({
    login: p.login,
    playerId: p.playerId,
    name: p.profile?.name || p.login,
    avatar: p.profile?.avatar || '',
    balance: p.gameData?.balance || 0,
    clanName: p.clanId ? (clanNames.get(p.clanId) || '') : ''
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


// === КЛАНЫ, НАГРАДЫ (серверные, MongoDB) ===
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_REWARD_AMOUNTS = [500000, 1000000, 1500000, 2500000, 4000000, 6000000, 15000000];
function safeClan(c) {
  if (!c) return null;
  return { clanId:c.clanId, name:c.name, avatar:c.avatar||'', leaderLogin:c.leaderLogin,
    leaderPlayerId:c.leaderPlayerId, members:c.members||[], createdAt:c.createdAt,
    memberCount:(c.members||[]).length };
}
async function currentUserDoc(login) { return db.collection('users').findOne({login}); }
async function clanForUser(user) {
  if (!user || !user.clanId) return null;
  return db.collection('clans').findOne({clanId:user.clanId});
}
app.get('/api/clan', requireAuth, async (req,res)=>{
  const u=await currentUserDoc(req.userLogin); if(!u)return res.status(404).json({error:'Игрок не найден'});
  const clan=await clanForUser(u);
  const invites=u.clanInvites||[];
  const pending=clan && clan.leaderLogin===u.login ? (clan.requests||[]) : [];
  const messages=clan ? await db.collection('clanMessages').find({clanId:clan.clanId}).sort({createdAt:-1}).limit(100).toArray() : [];
  res.json({clan:safeClan(clan),invites,pending,messages:messages.reverse().map(m=>({login:m.login,playerId:m.playerId,name:m.name,text:m.text,createdAt:m.createdAt})),isLeader:!!clan&&clan.leaderLogin===u.login});
});
app.post('/api/clan/create', requireAuth, async(req,res)=>{
  const u=await currentUserDoc(req.userLogin); if(!u)return res.status(404).json({error:'Игрок не найден'});
  if(u.clanId)return res.status(400).json({error:'Ты уже состоишь в клане'});
  const name=String(req.body.name||'').trim();
  const avatar=String(req.body.avatar||'');
  if(name.length<3||name.length>24)return res.status(400).json({error:'Название клана: 3–24 символа'});
  if(avatar && avatar.length>300000)return res.status(400).json({error:'Аватар слишком большой'});
  if(avatar && !/^data:image\/(png|jpeg|webp|gif);base64,/i.test(avatar))return res.status(400).json({error:'Неверный формат аватара'});
  if(await db.collection('clans').findOne({nameLower:name.toLowerCase()}))return res.status(409).json({error:'Клан с таким названием уже существует'});
  const balance=Number(u.gameData?.balance||0);
  if(balance<100000000)return res.status(400).json({error:'Создание клана стоит 100 000 000 ₽'});
  const clanId=crypto.randomBytes(12).toString('hex');
  const member={login:u.login,playerId:u.playerId,name:u.profile?.name||u.login,role:'leader',joinedAt:Date.now()};
  const clan={clanId,name,nameLower:name.toLowerCase(),avatar,leaderLogin:u.login,leaderPlayerId:u.playerId,members:[member],requests:[],invites:[],createdAt:Date.now()};
  const session=db.clientSession; // intentionally unused; updates below are atomic by user filter
  const result=await db.collection('users').updateOne({login:u.login,'gameData.balance':{$gte:100000000},clanId:{$exists:false}},{$inc:{'gameData.balance':-100000000},$set:{clanId}});
  if(!result.modifiedCount)return res.status(409).json({error:'Баланс или статус клана изменился. Обнови игру.'});
  try { await db.collection('clans').insertOne(clan); } catch(e) { await db.collection('users').updateOne({login:u.login},{$unset:{clanId:''},$inc:{'gameData.balance':100000000}}); return res.status(409).json({error:'Название уже занято'}); }
  res.json({success:true,clan:safeClan(clan)});
});
app.post('/api/clan/invite',requireAuth,async(req,res)=>{
  const leader=await currentUserDoc(req.userLogin),clan=await clanForUser(leader);
  if(!clan||clan.leaderLogin!==req.userLogin)return res.status(403).json({error:'Приглашать может только лидер'});
  const playerId=String(req.body.playerId||'').trim();
  const target=await db.collection('users').findOne({playerId});
  if(!target)return res.status(404).json({error:'Игрок с таким ID не найден'});
  if(target.clanId)return res.status(400).json({error:'Игрок уже в клане'});
  if(target.login===leader.login)return res.status(400).json({error:'Нельзя пригласить себя'});
  if((clan.members||[]).length>=30)return res.status(400).json({error:'В клане максимум 30 участников'});
  await db.collection('clans').updateOne({clanId:clan.clanId},{$addToSet:{invites:target.login}});
  await db.collection('users').updateOne({login:target.login},{$addToSet:{clanInvites:{clanId:clan.clanId,clanName:clan.name,from:leader.login,createdAt:Date.now()}}});
  res.json({success:true});
});
app.post('/api/clan/invite/respond',requireAuth,async(req,res)=>{
  const accept=!!req.body.accept,clanId=String(req.body.clanId||'');
  const u=await currentUserDoc(req.userLogin);
  const clan=await db.collection('clans').findOne({clanId});
  if(!clan)return res.status(404).json({error:'Клан не найден'});
  if(!(u.clanInvites||[]).some(i=>i.clanId===clanId))return res.status(403).json({error:'Приглашение не найдено'});
  if(accept){
    if(u.clanId)return res.status(400).json({error:'Ты уже в клане'});
    if(clan.members.length>=30)return res.status(400).json({error:'Клан заполнен'});
    await db.collection('clans').updateOne({clanId},{$push:{members:{login:u.login,playerId:u.playerId,name:u.profile?.name||u.login,role:'member',joinedAt:Date.now()}},$pull:{invites:u.login}});
    await db.collection('users').updateOne({login:u.login},{$set:{clanId},$pull:{clanInvites:{clanId}}});
  }else{
    await db.collection('clans').updateOne({clanId},{$pull:{invites:u.login}});
    await db.collection('users').updateOne({login:u.login},{$pull:{clanInvites:{clanId}}});
  }
  res.json({success:true});
});
app.post('/api/clan/apply',requireAuth,async(req,res)=>{
  const u=await currentUserDoc(req.userLogin);if(u.clanId)return res.status(400).json({error:'Ты уже в клане'});
  const name=String(req.body.name||'').trim();
  const clan=await db.collection('clans').findOne({nameLower:name.toLowerCase()});
  if(!clan)return res.status(404).json({error:'Клан не найден'});
  if(clan.requests?.some(r=>r.login===u.login))return res.status(409).json({error:'Заявка уже отправлена'});
  if(clan.members.length>=30)return res.status(400).json({error:'Клан заполнен'});
  await db.collection('clans').updateOne({clanId:clan.clanId},{$push:{requests:{login:u.login,playerId:u.playerId,name:u.profile?.name||u.login,createdAt:Date.now()}}});
  res.json({success:true});
});
app.post('/api/clan/request/respond',requireAuth,async(req,res)=>{
  const leader=await currentUserDoc(req.userLogin),clan=await clanForUser(leader);
  if(!clan||clan.leaderLogin!==leader.login)return res.status(403).json({error:'Только лидер'});
  const login=String(req.body.login||''),accept=!!req.body.accept;
  const request=(clan.requests||[]).find(r=>r.login===login);
  if(!request)return res.status(404).json({error:'Заявка не найдена'});
  const target=await currentUserDoc(login);
  if(accept&&target&&!target.clanId&&clan.members.length<30){
    await db.collection('clans').updateOne({clanId:clan.clanId},{$push:{members:{login:target.login,playerId:target.playerId,name:target.profile?.name||target.login,role:'member',joinedAt:Date.now()}},$pull:{requests:{login}}});
    await db.collection('users').updateOne({login:target.login},{$set:{clanId:clan.clanId}});
  }else await db.collection('clans').updateOne({clanId:clan.clanId},{$pull:{requests:{login}}});
  res.json({success:true});
});
app.post('/api/clan/chat',requireAuth,async(req,res)=>{
  const u=await currentUserDoc(req.userLogin),clan=await clanForUser(u);
  if(!clan)return res.status(400).json({error:'Ты не в клане'});
  const text=String(req.body.text||'').trim().slice(0,500);
  if(!text)return res.status(400).json({error:'Пустое сообщение'});
  await db.collection('clanMessages').insertOne({clanId:clan.clanId,login:u.login,playerId:u.playerId,name:u.profile?.name||u.login,text,createdAt:Date.now()});
  await db.collection('clanMessages').deleteMany({clanId:clan.clanId,_id:{$nin:(await db.collection('clanMessages').find({clanId:clan.clanId}).sort({createdAt:-1}).limit(300).toArray()).map(x=>x._id)}});
  res.json({success:true});
});
app.post('/api/clan/leave',requireAuth,async(req,res)=>{
 const u=await currentUserDoc(req.userLogin),clan=await clanForUser(u);if(!clan)return res.status(400).json({error:'Нет клана'});
 if(clan.leaderLogin===u.login)return res.status(400).json({error:'Лидер не может выйти; сначала передай лидерство (пока недоступно)'});
 await db.collection('clans').updateOne({clanId:clan.clanId},{$pull:{members:{login:u.login}}});
 await db.collection('users').updateOne({login:u.login},{$unset:{clanId:''}});
 res.json({success:true});
});
app.get('/api/rewards',requireAuth,async(req,res)=>{
 const u=await currentUserDoc(req.userLogin),r=u.rewards||{};
 const today=new Date().toISOString().slice(0,10);
 res.json({today,lastClaim:r.lastClaim||'',streak:r.streak||0,claimedToday:r.lastClaim===today,weeklyClaimed:r.weeklyClaimed||false,weeklyReady:Math.floor((r.streak||0)/7)>Number(r.weeklyClaimedWeek||0)});
});
app.post('/api/rewards/claim',requireAuth,async(req,res)=>{
 const u=await currentUserDoc(req.userLogin);let r=u.rewards||{};
 const today=new Date().toISOString().slice(0,10);
 if(r.lastClaim===today)return res.status(409).json({error:'Сегодня награда уже получена'});
 const yesterday=new Date(Date.now()-DAY_MS).toISOString().slice(0,10);
 const streak=r.lastClaim===yesterday?(r.streak||0)+1:1;
 const day=((streak-1)%7)+1,amount=DAILY_REWARD_AMOUNTS[day-1];
 await db.collection('users').updateOne({login:u.login,'rewards.lastClaim':r.lastClaim||{$exists:false}},{$set:{rewards:{...r,lastClaim:today,streak}},$inc:{'gameData.balance':amount}});
 res.json({success:true,streak,amount,weekly:0});
});

app.post('/api/rewards/weekly',requireAuth,async(req,res)=>{
 const u=await currentUserDoc(req.userLogin),r=u.rewards||{},streak=Number(r.streak||0);
 const week=Math.floor(streak/7);
 if(week<1)return res.status(400).json({error:'Сначала забери 7 ежедневных наград'});
 if(Number(r.weeklyClaimedWeek||0)>=week)return res.status(409).json({error:'Недельная награда уже получена'});
 await db.collection('users').updateOne({login:u.login},{$set:{'rewards.weeklyClaimedWeek':week},$inc:{'gameData.balance':25000000}});
 res.json({success:true,amount:25000000,week});
});

// ЗАПУСК СЕРВЕРА
MongoClient.connect(MONGODB_URI)
  .then(async client => {
    db = client.db(DB_NAME);
    await db.collection('users').createIndex({ login: 1 }, { unique: true });
    await db.collection('users').createIndex({ playerId: 1 }, { unique: true, sparse: true });
    await db.collection('clans').createIndex({ nameLower: 1 }, { unique: true });
    await db.collection('clans').createIndex({ clanId: 1 }, { unique: true });

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
