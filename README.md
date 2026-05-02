# PayBack — Shared Expense Tracker MVP

---

## What is this?

PayBack is a shared expense tracker built for groups of friends and roommates in Kazakhstan. This MVP tests the core hypothesis:

**"If we build automatic debt calculation with minimum transfers, users will prefer it over tracking expenses manually in WhatsApp chats."**

---

## MVP Features

- Create a group with custom members
- Add expenses with split logic (split equally between any members)
- Automatic debt simplification (greedy algorithm — minimum transfers)
- Net balance view per person
- Delete expenses
- Category tagging (food, transport, housing, entertainment, other)

---

## How to Run

### Option 1: Open directly (no server needed)

open frontend/index.html


Or just double-click `frontend/index.html` in your file explorer.

### Option 2: Local server

```bash
cd frontend
python3 -m http.server 3000
# Open http://localhost:3000
```

---

## How to Use

1. **Setup screen** — Enter group name and add at least 2 members
2. **Expenses tab** — Add expenses: title, amount, who paid, who splits it
3. **Balances tab** — See net balances and minimum transfers needed

---

## Architecture

This MVP is a single HTML file with:
- Vanilla JS (no framework dependencies)
- In-memory state (no backend/database required for prototype)
- Debt simplification algorithm built-in

**Production stack** (defined in Assignments 1–3):
- Frontend: React + Vite → Vercel
- Backend: Node.js + Express → Railway
- Database: PostgreSQL (10 tables, ACID transactions)

---

## MVP Hypothesis

| Field | Answer |
|---|---|
| Problem | After group trips, no one knows who owes what |
| Riskiest assumption | Users will trust automated calculations over manual tracking |
| Hypothesis | If we show minimum transfers automatically, users will settle debts faster |
| What MVP is NOT | No auth, no Kaspi QR, no notifications, no history |
| How to test | Do users complete the expense → balance flow without confusion? |

---

## Tech Debt Introduced

- No persistent storage (data lost on refresh)
- No authentication (anyone can access any group)
- No input sanitization beyond basic validation
- Equal split only (no % or custom amount in prototype)

These are acceptable for MVP — the goal is to test the hypothesis, not build the full product.
