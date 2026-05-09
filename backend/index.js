const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'payback-dev-secret';
const SALT_ROUNDS = 10;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── JWT Middleware ─────────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }
  const token = authHeader.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Auth Routes ───────────────────────────────────────────────────────────────

app.post('/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' });
  }
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name, email.trim().toLowerCase(), passwordHash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
    res.status(201).json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/users/search', authMiddleware, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query is required' });
  try {
    const result = await pool.query(
      'SELECT id, name, email FROM users WHERE email = LOWER($1) OR LOWER(name) = LOWER($1) LIMIT 1',
      [q.trim()]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.use('/groups', authMiddleware);

app.get('/groups', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT g.id, g.name, g.created_at
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = $1
       ORDER BY g.created_at DESC`,
      [String(req.user.id)]
    );
    res.json({ groups: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Debt Simplification ───────────────────────────────────────────────────────
function simplifyDebts(memberIds, rows) {
  const net = {};
  memberIds.forEach(id => { net[id] = 0; });

  rows.forEach(({ paid_by, amount, user_id, amount_owed }) => {
    net[paid_by] = (net[paid_by] || 0) + parseFloat(amount);
    net[user_id] = (net[user_id] || 0) - parseFloat(amount_owed);
  });

  const creditors = [];
  const debtors = [];
  Object.entries(net).forEach(([id, balance]) => {
    if (balance > 0.01) creditors.push({ id, amount: balance });
    else if (balance < -0.01) debtors.push({ id, amount: -balance });
  });

  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const transfers = [];
  let i = 0, j = 0;
  while (i < creditors.length && j < debtors.length) {
    const transfer = Math.min(creditors[i].amount, debtors[j].amount);
    transfers.push({ from: debtors[j].id, to: creditors[i].id, amount: Math.round(transfer) });
    creditors[i].amount -= transfer;
    debtors[j].amount -= transfer;
    if (creditors[i].amount < 0.01) i++;
    if (debtors[j].amount < 0.01) j++;
  }

  return { net, transfers };
}

// ── Group Routes ──────────────────────────────────────────────────────────────

app.post('/groups', async (req, res) => {
  const { name, members } = req.body;
  if (!name || !members || members.length < 1) {
    return res.status(400).json({ error: 'Group name and at least 1 other member required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inviteCode = uuidv4().slice(0, 8);
    const groupResult = await client.query(
      'INSERT INTO groups (name, invite_code, created_by) VALUES ($1, $2, $3) RETURNING *',
      [name, inviteCode, req.user.id]
    );
    const group = groupResult.rows[0];
    await client.query(
      'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [group.id, String(req.user.id)]
    );
    for (const member of members) {
      if (member.isGuest) {
        await client.query(
          'INSERT INTO group_members (group_id, user_id, guest_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [group.id, uuidv4(), member.name]
        );
      } else {
        await client.query(
          'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [group.id, String(member.id)]
        );
      }
    }
    await client.query('COMMIT');
    res.status(201).json(group);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// GET /groups/join/:code — preview group name by invite code (for join screen, no membership change)
app.get('/groups/join/:code', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name FROM groups WHERE invite_code = $1', [req.params.code]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invalid invite code' });
    res.json({ group: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /groups/join/:code — add logged-in user to the group, converting guest if name matches
app.post('/groups/join/:code', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name FROM groups WHERE invite_code = $1', [req.params.code]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invalid invite code' });
    const group = result.rows[0];
    const existing = await pool.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [group.id, String(req.user.id)]
    );
    if (existing.rows.length > 0) {
      return res.json({ group, message: 'Already a member' });
    }
    const guestRow = await pool.query(
      'SELECT user_id FROM group_members WHERE group_id = $1 AND LOWER(guest_name) = LOWER($2)',
      [group.id, req.user.name]
    );
    if (guestRow.rows.length > 0) {
      await pool.query(
        'UPDATE group_members SET user_id = $1, guest_name = NULL WHERE group_id = $2 AND user_id = $3',
        [String(req.user.id), group.id, guestRow.rows[0].user_id]
      );
    } else {
      await pool.query(
        'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [group.id, String(req.user.id)]
      );
    }
    res.json({ group });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/groups/:id', async (req, res) => {
  try {
    const groupResult = await pool.query('SELECT * FROM groups WHERE id = $1', [req.params.id]);
    if (groupResult.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
    const group = groupResult.rows[0];

    const membersResult = await pool.query(
      `SELECT gm.user_id as id, u.name as real_name, gm.guest_name
       FROM group_members gm
       LEFT JOIN users u ON u.id::text = gm.user_id
       WHERE gm.group_id = $1`,
      [group.id]
    );
    const members = membersResult.rows.map(row => ({
      id: row.id,
      name: row.real_name || row.guest_name || row.id,
      isGuest: !row.real_name
    }));

    const expensesResult = await pool.query(
      `SELECT
        e.id,
        e.title,
        e.amount,
        e.category,
        e.paid_by as "paidBy",
        COALESCE((SELECT name FROM users WHERE id::text = e.paid_by), e.paid_by) as "paidByName",
        json_agg(es.user_id) as "splitBetween"
      FROM expenses e
      LEFT JOIN expense_splits es ON es.expense_id = e.id
      WHERE e.group_id = $1
      GROUP BY e.id
      ORDER BY e.created_at DESC`,
      [group.id]
    );

    const expenses = expensesResult.rows.map(exp => ({
      ...exp,
      amount: parseFloat(exp.amount),
      splitBetween: exp.splitBetween[0] === null ? [] : exp.splitBetween
    }));

    res.json({ ...group, members, expenses });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /groups/:id/invite — return invite code for a group
app.get('/groups/:id/invite', async (req, res) => {
  try {
    const result = await pool.query('SELECT invite_code FROM groups WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
    res.json({ invite_code: result.rows[0].invite_code });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/groups/:id/expenses', async (req, res) => {
  const { title, amount, paidBy, splitBetween, category } = req.body;
  
  if (!title || !amount || amount <= 0 || !paidBy || !splitBetween || splitBetween.length === 0) {
    return res.status(400).json({ error: 'Invalid expense data' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const memberCheck = await client.query(
      `SELECT user_id FROM group_members
       WHERE group_id = $1
       AND (user_id = $2 OR guest_name = $2 OR user_id IN (SELECT id::text FROM users WHERE name = $2))`,
      [req.params.id, String(paidBy)]
    );

    if (memberCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Payer is not a group member' });
    }

    const expResult = await client.query(
      'INSERT INTO expenses (group_id, title, amount, paid_by, category) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.params.id, title, parseFloat(amount), String(paidBy), category || 'other']
    );
    const expense = expResult.rows[0];

    const share = parseFloat(amount) / splitBetween.length;
    for (const userId of splitBetween) {
      await client.query(
        'INSERT INTO expense_splits (expense_id, user_id, amount_owed) VALUES ($1, $2, $3)',
        [expense.id, String(userId), share]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ...expense, amount: parseFloat(expense.amount), paidBy, splitBetween });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

app.get('/groups/:id/balances', async (req, res) => {
  try {
    // Получаем всех участников (имена и UUID)
    const membersResult = await pool.query(
      'SELECT user_id FROM group_members WHERE group_id = $1',
      [req.params.id]
    );
    const memberIds = membersResult.rows.map(r => r.user_id);

    // Получаем все сплиты. Мы используем COALESCE, чтобы получить имя плательщика, 
    // если он зарегистрирован, или его текстовый ID.
    const rows = await pool.query(
      `SELECT 
        COALESCE(u.id::text, e.paid_by) as paid_by,
        e.amount,
        es.user_id,
        es.amount_owed
       FROM expenses e
       JOIN expense_splits es ON es.expense_id = e.id
       LEFT JOIN users u ON u.id::text = e.paid_by
       WHERE e.group_id = $1`,
      [req.params.id]
    );

    const { net, transfers } = simplifyDebts(memberIds, rows.rows);
    res.json({ net, transfers });
  } catch (err) {
    console.error('Ошибка баланса:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/groups/:id/expenses/:expenseId', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM expenses WHERE id = $1 AND group_id = $2 RETURNING id',
      [req.params.expenseId, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Expense not found' });
    res.json({ message: 'Expense deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/groups/:id/members', async (req, res) => {
  const { userId, name, isGuest } = req.body;
  if (!isGuest && !userId) return res.status(400).json({ error: 'User ID required' });
  if (isGuest && !name) return res.status(400).json({ error: 'Guest name required' });
  try {
    if (isGuest) {
      const existing = await pool.query(
        `SELECT 1 FROM group_members WHERE group_id = $1
         AND (LOWER(guest_name) = LOWER($2) OR user_id IN (SELECT id::text FROM users WHERE LOWER(name) = LOWER($2)))`,
        [req.params.id, name]
      );
      if (existing.rows.length > 0) return res.status(409).json({ error: 'Member with this name already in group' });
      await pool.query(
        'INSERT INTO group_members (group_id, user_id, guest_name) VALUES ($1, $2, $3)',
        [req.params.id, uuidv4(), name]
      );
    } else {
      const existing = await pool.query(
        'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
        [req.params.id, String(userId)]
      );
      if (existing.rows.length > 0) return res.status(409).json({ error: 'User already in group' });
      await pool.query(
        'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)',
        [req.params.id, String(userId)]
      );
    }
    res.status(201).json({ message: 'Member added' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/groups/:id/members/:memberId', async (req, res) => {
  try {
    const groupCheck = await pool.query('SELECT created_by FROM groups WHERE id = $1', [req.params.id]);
    if (!groupCheck.rows.length) return res.status(404).json({ error: 'Group not found' });
    if (String(groupCheck.rows[0].created_by) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Only the group owner can remove members' });
    }
    if (req.params.memberId === String(req.user.id)) {
      return res.status(400).json({ error: 'Cannot remove yourself' });
    }
    const result = await pool.query(
      'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2 RETURNING user_id',
      [req.params.id, req.params.memberId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Member not found' });
    res.json({ message: 'Member removed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/groups/:id/members/guest', async (req, res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName) return res.status(400).json({ error: 'Old name and new name required' });
  try {
    const result = await pool.query(
      'UPDATE group_members SET guest_name = $1 WHERE group_id = $2 AND LOWER(guest_name) = LOWER($3) RETURNING user_id',
      [newName, req.params.id, oldName]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Guest not found' });
    res.json({ message: 'Guest renamed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch {
    res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`PayBack API running on port ${PORT}`));
