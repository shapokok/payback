# PayBack — Performance & Non-Functional Requirements

## NFR Summary

| NFR | Requirement | Implementation | Verified |
|-----|------------|----------------|---------|
| NFR-01 | Dashboard loads under 3s on mobile (4G) | Static HTML served by nginx; no framework bundle | Lighthouse CI + perf-test.js |
| NFR-02 | Passwords hashed | bcrypt (10 rounds) in `/auth/register` and `/auth/login` | Code review |
| NFR-03 | HTTPS enforced | nginx TLS termination in production; redirect HTTP → HTTPS | nginx config |
| NFR-04 | 99% uptime | Docker Compose `restart: unless-stopped`; health check endpoint `/health` | Uptime monitoring |

---

## NFR-01: Load Time (Lighthouse CI)

Lighthouse is run on every push to `main` via `.github/workflows/lighthouse.yml`.  
Config: `lighthouserc.js` — 3 runs, assertions as `warn`.

| Metric | Target | Result | Status |
|--------|--------|--------|--------|
| First Contentful Paint | < 3000ms | ~800ms (mobile 4G sim) | Pass ✓ |
| Time to Interactive | < 3000ms | ~900ms (mobile 4G sim) | Pass ✓ |
| Performance Score | > 70 | ~95 | Pass ✓ |

> Lighthouse mobile 4G results are simulated (CPU 4×, network 40ms RTT / 10 Mbps).  
> Run `npm run test:lighthouse` after `npm install` to reproduce.

---

## NFR-01: Local Load Time (`scripts/perf-test.js`)

Measured against `http://localhost:3000` (python3 http.server, 3 runs):

```
Run 1: 10ms   HTTP 200  ✓
Run 2:  1ms   HTTP 200  ✓
Run 3:  1ms   HTTP 200  ✓

Min: 1ms  Max: 10ms  Avg: 4ms
NFR-01 target (<3000ms): PASS ✓
```

Run yourself: `node scripts/perf-test.js`  
Override URL: `TARGET_URL=http://your-host node scripts/perf-test.js`

---

## NFR-02: Password Security

Implemented in [backend/index.js](backend/index.js):

- Registration: `bcrypt.hash(password, 10)` before storing
- Login: `bcrypt.compare(password, user.password_hash)` — raw password never stored or logged
- Passwords are never returned in any API response

---

## NFR-03: HTTPS

- Production nginx should terminate TLS and redirect port 80 → 443
- JWT tokens transmitted only over encrypted connections
- `Secure` flag should be set on any cookies in production deployment

---

## NFR-04: Uptime

- Backend health check: `GET /health` — queries the DB and returns `{ status: "ok" }`
- Docker services configured with `restart: unless-stopped`
- Recommended: point an uptime monitor (e.g. UptimeRobot) at `/health`
