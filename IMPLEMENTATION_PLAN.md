# PayBack — Architecture & Implementation Plan

## Current State (What Exists)

```
payback/
├── backend/
│   └── index.js          # Express REST API, in-memory storage, JWT auth, debt algorithm
├── frontend/
│   └── index.html        # Vanilla JS SPA — auth, group creation, expenses, balances
└── docker-compose.yml    # Local orchestration (backend :3001, frontend :3000)
```

**What works today:** Register → Login → Create group → Add expenses (equal split) → View debts (simplified)

**What is missing:** Kaspi QR, invite links, persistent DB, split by % or fixed amount, settlements, history, notifications, multi-language, receipt photos.

---

## Target Architecture

```
┌─────────────────────────────────────────────────────┐
│                    CLIENT (React)                    │
│  Auth │ Dashboard │ Expenses │ Balances │ History    │
│              Kaspi QR (client-side gen)              │
└──────────────────┬──────────────────────────────────┘
                   │ HTTPS / REST
┌──────────────────▼──────────────────────────────────┐
│               BACKEND (Node.js + Express)            │
│  /auth  │  /groups  │  /expenses  │  /settlements   │
│         Balance Engine │ History Logs                │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│                  PostgreSQL                          │
│  users │ groups │ members │ expenses │ expense_splits│
│  settlements │ balances │ logs                       │
└─────────────────────────────────────────────────────┘
```

---

## Database Schema (Target)

```sql
users           (id, name, email, password_hash, kaspi_phone, created_at)
                -- kaspi_phone is optional; shown only to the debtor in that pair
groups          (id, name, invite_code, created_by, created_at)
group_members   (group_id, user_id, joined_at)
                -- only registered users can be members (no anonymous names)
expenses        (id, group_id, title, amount, paid_by, category, split_type, created_at)
expense_splits  (id, expense_id, user_id, amount_owed)
settlements     (id, group_id, from_user, to_user, amount, status, created_at, confirmed_at)
                -- status: pending_confirmation | confirmed
balances        (group_id, user_id, net_balance)          -- derived, cached
expense_logs    (id, expense_id, action, actor_id, ts)    -- audit trail
```

---

## Implementation Phases

### Phase 1 — Persistent Storage (Foundation)
**Goal:** Stop losing data on restart. Everything else depends on this.

- [ ] Add PostgreSQL to `docker-compose.yml`
- [ ] Replace in-memory `users` and `store` objects with DB queries in `backend/index.js`
- [ ] Create migration file: `backend/migrations/001_initial_schema.sql`
  - Tables: `users`, `groups`, `group_members`, `expenses`, `expense_splits`
- [ ] Use `pg` npm package for DB access
- [ ] Update JWT expiry from 7 days → 24 hours (per spec)

**Files to change:** `backend/index.js`, `docker-compose.yml`, new `backend/migrations/`

---

### Phase 2 — Invite Links
**Goal:** Let users actually invite friends to a group (US-02).

- [ ] Add `invite_code` column to groups table (random 8-char token, generated on group creation)
- [ ] `GET /groups/join/:invite_code` — return group info
- [ ] `POST /groups/join/:invite_code` — add authenticated user as a member
- [ ] Frontend: show shareable link on the group screen (e.g. `payback.app/join/abc123`)
- [ ] Frontend: add a "Join group" flow on the auth screen for users arriving via invite link

**Files to change:** `backend/index.js`, `frontend/index.html`

---

### Phase 3 — Split Methods (US-04)
**Goal:** Support equal split, percentage split, and fixed-amount split.

- [ ] Add `split_type` field to expense form: `equal | percentage | fixed`
- [ ] When `percentage`: show input per member that must sum to 100%
- [ ] When `fixed`: show amount input per member that must sum to expense total
- [ ] Backend: store individual amounts in `expense_splits` table (already in schema)
- [ ] Backend: update balance calculation to read from `expense_splits` instead of dividing equally
- [ ] Frontend: update the add-expense form UI with split method selector

**Files to change:** `backend/index.js`, `frontend/index.html`

---

### Phase 4 — Phone Number Display & Settlements (US-07, Workflow 1)
**Goal:** Let debtors see the creditor's Kaspi phone number and mark debts as paid with two-sided confirmation.

**Requirements clarified:**
- Phone number is entered in profile settings (optional field)
- If no phone set → show placeholder "Номер не указан" — debt still visible
- Phone number shown only to the person who owes (debtor only, not all group members)
- Phone revealed on tap/expand — not shown inline by default
- Settlement flow: debtor taps "Оплатил" → creditor gets in-app notification → creditor confirms → debt removed
- All group members must be registered users (no anonymous names)

**Tasks:**
- [ ] Add `kaspi_phone` optional field to `users` table and profile settings screen
- [ ] Balances screen: each transfer card is collapsible — tap to expand reveals creditor's phone number (only visible to the debtor)
- [ ] If creditor has no phone set, show "Номер не указан" inside expanded card
- [ ] Add "Оплатил" button inside the expanded card (visible to debtor only)
- [ ] `POST /groups/:id/settlements` — creates settlement record with status `pending_confirmation`
- [ ] In-app notification badge/indicator for creditor: "X заплатил тебе — подтверди"
- [ ] Creditor sees a "Подтвердить получение" button — on confirm, settlement status → `confirmed`, debt removed from list
- [ ] Recalculate and update balances after confirmation
- [ ] Frontend: transfer disappears from list only after both sides confirm

**Files to change:** `backend/index.js`, `frontend/index.html`, DB schema (`settlements` table needs `status` column)

---

### Phase 5 — History & Audit Log
**Goal:** Show a log of all activity so users can review what happened.

- [ ] Backend: insert a row into `expense_logs` on every add/delete/settle action
- [ ] `GET /groups/:id/history` — return paginated log
- [ ] Frontend: add a "History" tab showing timestamped activity feed
  - "Akezhan added 'Dinner' — 5,000 ₸"
  - "Nurshapagat settled 2,500 ₸ to Akezhan"

**Files to change:** `backend/index.js`, `frontend/index.html`

---

### Phase 6 — React Migration
**Goal:** Replace the 972-line `index.html` monolith with maintainable React components. Matches the tech stack specified in the assignment.

- [ ] Scaffold with `npm create vite@latest frontend -- --template react`
- [ ] Component breakdown:
  ```
  src/
  ├── pages/        AuthPage, SetupPage, GroupPage
  ├── components/   ExpenseForm, ExpenseList, BalanceGrid,
  │                 TransferList, KaspiQR, HistoryFeed
  ├── hooks/        useGroup, useExpenses, useBalances
  └── api/          auth.js, groups.js, expenses.js, settlements.js
  ```
- [ ] Move all API calls from inline fetch → `src/api/` modules
- [ ] Keep the same backend API — no backend changes needed in this phase

**Files to change:** replace `frontend/index.html` entirely

---

### Phase 7 — Multi-language Support
**Goal:** Russian, Kazakh, English (per non-functional requirements).

- [ ] Add `i18next` + `react-i18next`
- [ ] Create translation files: `public/locales/{en,ru,kk}/translation.json`
- [ ] Add language selector to the top navbar
- [ ] All UI strings go through `t('key')` — no hardcoded English text

**Files to change:** frontend only

---

### Phase 8 — Non-Functional Hardening
**Goal:** Meet the remaining non-functional requirements from the spec.

- [ ] HTTPS: configure TLS termination (handled by Vercel/Railway automatically on deploy)
- [ ] Receipt photo upload: `POST /expenses/:id/receipt` accepts image, store in object storage (e.g. Cloudflare R2 free tier), reject files > 5MB
- [ ] Notifications / reminders: send a reminder if a debt is unsettled for 3+ days
  - Use a cron job or Railway scheduled task
  - Delivery: email (nodemailer) or in-app notification badge
- [ ] Input sanitization: sanitize all user-facing strings to prevent XSS
- [ ] Rate limiting: add `express-rate-limit` to auth endpoints

---

## Priority Order Summary

| Phase | What | Depends On | Priority |
|-------|------|-----------|----------|
| 1 | PostgreSQL persistence | nothing | **Critical** |
| 2 | Invite links | Phase 1 | **High** |
| 3 | Split methods | Phase 1 | **High** |
| 4 | Kaspi QR + Settlements | Phase 1, 3 | **High** (core differentiator) |
| 5 | History & logs | Phase 1 | Medium |
| 6 | React migration | Phase 1–4 done | Medium |
| 7 | Multi-language | Phase 6 | Low |
| 8 | NFR hardening | Phase 6 | Low |

---

## Feature Coverage vs. Requirements

| Requirement | Current | Target Phase |
|---|---|---|
| US-01 Register/Login | Done | — |
| US-02 Invite via link | Partial (no link) | Phase 2 |
| US-03 Add expense (name, amount, category, payer) | Done | — |
| US-04 Split equally / by % / fixed | Equal only | Phase 3 |
| US-05 Auto-calculate who owes whom | Done | — |
| US-06 Debt simplification | Done | — |
| US-07 Показ номера Kaspi + погашение долга | Missing | Phase 4 |
| Persistent storage | Missing | Phase 1 |
| Settlement / mark as paid | Missing | Phase 4 |
| History log | Missing | Phase 5 |
| Multi-language (RU, KK, EN) | Missing | Phase 7 |
| HTTPS + 24h session | Partial | Phase 1 + 8 |
| Receipt photos | Missing | Phase 8 |
| Notifications | Missing | Phase 8 |
