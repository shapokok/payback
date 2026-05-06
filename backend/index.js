const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'payback-dev-secret';
const SALT_ROUNDS = 10;

// ── In-memory stores ──────────────────────────────────────────────────────────
const users = {}; // { email: { id, name, email, passwordHash } }
const store = {}; // { groupId: { id, name, members: [], expenses: [] } }

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

// POST /auth/register
app.post('/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' });
  }
  if (users[email]) {
    return res.status(409).json({ error: 'Email already registered' });
  }
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = { id: uuidv4(), name, email, passwordHash };
  users[email] = user;
  const token = jwt.sign({ id: user.id, name, email }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ token, user: { id: user.id, name, email } });
});

// POST /auth/login
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const user = users[email];
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, name: user.name, email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, email } });
});

// ── Apply JWT middleware to all /groups routes ─────────────────────────────────
app.use('/groups', authMiddleware);

// ── Helper: Debt Simplification Algorithm ────────────────────────────────────
function simplifyDebts(members, expenses) {
  const net = {};
  members.forEach(m => { net[m] = 0; });

  expenses.forEach(exp => {
    const { paidBy, amount, splitBetween } = exp;
    const share = amount / splitBetween.length;
    net[paidBy] = (net[paidBy] || 0) + amount;
    splitBetween.forEach(member => {
      net[member] = (net[member] || 0) - share;
    });
  });

  const creditors = [];
  const debtors = [];
  Object.entries(net).forEach(([name, balance]) => {
    if (balance > 0.01) creditors.push({ name, amount: balance });
    else if (balance < -0.01) debtors.push({ name, amount: -balance });
  });

  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const transfers = [];
  let i = 0, j = 0;
  while (i < creditors.length && j < debtors.length) {
    const transfer = Math.min(creditors[i].amount, debtors[j].amount);
    transfers.push({
      from: debtors[j].name,
      to: creditors[i].name,
      amount: Math.round(transfer)
    });
    creditors[i].amount -= transfer;
    debtors[j].amount -= transfer;
    if (creditors[i].amount < 0.01) i++;
    if (debtors[j].amount < 0.01) j++;
  }

  return { net, transfers };
}

// ── Group Routes ──────────────────────────────────────────────────────────────

// POST /groups — Create a new group
app.post('/groups', (req, res) => {
  const { name, members } = req.body;
  if (!name || !members || members.length < 2) {
    return res.status(400).json({ error: 'Group name and at least 2 members required' });
  }
  const id = uuidv4();
  store[id] = { id, name, members, expenses: [] };
  res.status(201).json(store[id]);
});

// GET /groups/:id — Get group details
app.get('/groups/:id', (req, res) => {
  const group = store[req.params.id];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  res.json(group);
});

// POST /groups/:id/expenses — Add an expense
app.post('/groups/:id/expenses', (req, res) => {
  const group = store[req.params.id];
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const { title, amount, paidBy, splitBetween, category } = req.body;
  if (!title || !amount || amount <= 0 || !paidBy || !splitBetween || splitBetween.length === 0) {
    return res.status(400).json({ error: 'Invalid expense data' });
  }
  if (!group.members.includes(paidBy)) {
    return res.status(400).json({ error: 'Payer is not a group member' });
  }

  const expense = {
    id: uuidv4(),
    title,
    amount: parseFloat(amount),
    paidBy,
    splitBetween,
    category: category || 'other',
    createdAt: new Date().toISOString()
  };
  group.expenses.push(expense);
  res.status(201).json(expense);
});

// GET /groups/:id/balances — Get balances and transfers
app.get('/groups/:id/balances', (req, res) => {
  const group = store[req.params.id];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const { net, transfers } = simplifyDebts(group.members, group.expenses);
  res.json({ net, transfers });
});

// DELETE /groups/:id/expenses/:expenseId — Delete an expense
app.delete('/groups/:id/expenses/:expenseId', (req, res) => {
  const group = store[req.params.id];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const idx = group.expenses.findIndex(e => e.id === req.params.expenseId);
  if (idx === -1) return res.status(404).json({ error: 'Expense not found' });
  group.expenses.splice(idx, 1);
  res.json({ message: 'Expense deleted' });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`PayBack API running on port ${PORT}`));
