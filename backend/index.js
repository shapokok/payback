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
      [name, email, passwordHash]
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
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
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

app.use('/groups', authMiddleware);

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
  const { name, memberIds } = req.body;
  if (!name || !memberIds || memberIds.length < 1) {
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
    const allMembers = [...new Set([req.user.id, ...memberIds])];
    for (const userId of allMembers) {
      await client.query(
        'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [group.id, userId]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ ...group, members: allMembers });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

app.get('/groups/:id', async (req, res) => {
  try {
    const groupResult = await pool.query('SELECT * FROM groups WHERE id = $1', [req.params.id]);
    if (groupResult.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
    const group = groupResult.rows[0];

    const membersResult = await pool.query(
      `SELECT u.id, u.name, u.email FROM users u
       JOIN group_members gm ON gm.user_id = u.id
       WHERE gm.group_id = $1`,
      [group.id]
    );

    const expensesResult = await pool.query(
      `SELECT e.*, u.name as paid_by_name,
              json_agg(json_build_object('user_id', es.user_id, 'amount_owed', es.amount_owed)) as splits
       FROM expenses e
       JOIN users u ON u.id = e.paid_by
       JOIN expense_splits es ON es.expense_id = e.id
       WHERE e.group_id = $1
       GROUP BY e.id, u.name
       ORDER BY e.created_at DESC`,
      [group.id]
    );

    res.json({ ...group, members: membersResult.rows, expenses: expensesResult.rows });
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
      'SELECT user_id FROM group_members WHERE group_id = $1 AND user_id = $2',
      [req.params.id, paidBy]
    );
    if (memberCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Payer is not a group member' });
    }

    const expResult = await client.query(
      'INSERT INTO expenses (group_id, title, amount, paid_by, category) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.params.id, title, parseFloat(amount), paidBy, category || 'other']
    );
    const expense = expResult.rows[0];
    const share = parseFloat(amount) / splitBetween.length;
    for (const userId of splitBetween) {
      await client.query(
        'INSERT INTO expense_splits (expense_id, user_id, amount_owed) VALUES ($1, $2, $3)',
        [expense.id, userId, share]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ...expense, splitBetween });
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
    const membersResult = await pool.query(
      'SELECT user_id FROM group_members WHERE group_id = $1',
      [req.params.id]
    );
    const memberIds = membersResult.rows.map(r => r.user_id);

    const rows = await pool.query(
      `SELECT e.paid_by, e.amount, es.user_id, es.amount_owed
       FROM expenses e
       JOIN expense_splits es ON es.expense_id = e.id
       WHERE e.group_id = $1`,
      [req.params.id]
    );

    const { net, transfers } = simplifyDebts(memberIds, rows.rows);
    res.json({ net, transfers });
  } catch (err) {
    console.error(err);
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
