// ================= АДМИН ПАНЕЛЬ =================
app.post('/api/admin/adjust', async (req, res) => {
  try {
    const { adminLogin, targetId, amount } = req.body;

    // Проверка, что запрос идет от админа Q1wesh
    if (adminLogin !== 'Q1wesh') {
      return res.status(403).json({ error: 'У вас нет прав администратора!' });
    }

    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount === 0) {
      return res.status(400).json({ error: 'Неверная сумма!' });
    }

    // Ищем игрока по playerId, если не нашли — по логину
    let user = await db.collection('users').findOne({ playerId: targetId });
    if (!user) {
      user = await db.collection('users').findOne({ login: targetId });
    }

    if (!user) {
      return res.status(404).json({ error: 'Игрок с таким ID/Логином не найден!' });
    }

    const currentBalance = user.gameData.balance || 0;
    const newBalance = Math.max(0, currentBalance + numAmount); // не уходим в минус

    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { 'gameData.balance': newBalance } }
    );

    res.json({ success: true, newBalance, action: numAmount >= 0 ? 'give' : 'take' });
  } catch (e) {
    console.error("Ошибка в админке:", e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
