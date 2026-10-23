# 🎴 CardMaking Backend (CMBE)

Backend for **CardMaking**, a web app where people design greeting cards and invitations online, publish them as shareable web pages, and edit them together in real time.

> 🚧 **Status:** early development. Email and password sign-up, sign-in, sign-out and `/me` work, including email verification, Google sign-in and rotating refresh tokens; the remaining feature modules are placeholders and are being implemented one by one.

## ✨ What is CardMaking?

Users build a card visually: drop text where they want it, pick colors and fonts, add images and shapes, and customize almost everything. A finished card is **published as a web page** (for example `domain.com/thiep/abcxyz`) that anyone can open and share, not a flat image.

## 🧩 Planned Features

- 🎨 **Card editor model**: a card is a JSON document with a canvas and an ordered list of elements (text, image, shape), each with position, size, rotation, opacity and animation.
- 🌐 **Publishing**: separate draft and published snapshot, public URL by slug, unpublish without losing the link, SEO controls (`indexable` flag, sitemap).
- 🤝 **Real-time collaboration**: operation-based editing over WebSocket with the server as the single source of truth, roles (owner, editor, viewer) and invite links.
- 🔐 **Authentication**: email and password sign-in with email verification, Google sign-in, short-lived access tokens with rotating refresh tokens.
- 🖼️ **Image uploads** with content-based type checks.
- 🧠 **MCP integration** (phase 2): lets an AI assistant create and edit cards through the same operation API the editor uses.

## 🛠️ Tech Stack

| Area | Technology |
| --- | --- |
| 🟢 Runtime | Node.js 22 |
| 🔷 Language | TypeScript (CommonJS) |
| 🚂 Web framework | Express 5 |
| 🍃 Database | MongoDB (replica set) |
| 🔺 ORM | Prisma 6 |
| 🔌 APIs | REST, GraphQL (Apollo Server), WebSocket |
| 🧰 Jobs and messaging | Redis + BullMQ |
| ✅ Validation | Zod |
| 🔑 Auth | jose (JWT), google-auth-library, cookie-parser |
| 🛡️ Security | helmet, express-rate-limit |
| 📤 Uploads | multer |
| 🪵 Logging | pino, pino-http |
| 🧪 Testing | Vitest, Supertest, mongodb-memory-server |

The WebSocket library will be chosen when that module is implemented.

## 🏗️ Architecture

CMBE is a **modular monolith** organized by feature. Each module owns its routes or resolvers, controllers and services, and shares code only through small, well-defined folders.

| Entry point | Used for |
| --- | --- |
| 🌍 REST (`/api/v1`) | Authentication, public card pages, image upload, health checks |
| 🧬 GraphQL (`/graphql`) | Everything the editor needs after sign-in: cards, operations, members, publishing, templates |
| ⚡ WebSocket (`/ws`) | Real-time collaboration on a card |
| 📮 Worker | Background jobs (BullMQ) |

Key rules:

- Services know nothing about HTTP, GraphQL or sockets; every entry point calls the same services.
- A card draft only changes through operations (`applyOps`), which keeps the editor, collaborators and AI clients consistent.
- Modules talk to each other through an event bus, not through imports.

### 📁 Project Structure

```text
CMBE/
├── prisma/            database schema
├── scripts/           build helpers
└── src/
    ├── server.ts      HTTP server and graceful shutdown
    ├── worker.ts      background job entry point
    ├── app.ts         Express app composition
    ├── config/        environment validation
    ├── http/          shared HTTP layer (origin check, validation, errors)
    ├── graphql/       GraphQL toolkit (context, guards, limits)
    ├── modules/
    │   ├── auth/          sign-in, sessions, tokens
    │   ├── cards/         cards, operations, members, publishing
    │   ├── publications/  read side of published cards
    │   ├── assets/        image uploads
    │   └── collab/        real-time collaboration
    ├── infra/         Prisma, logger, event bus, Redis, queues, storage
    ├── shared/        small dependency-free helpers
    └── types/
```

## 🚀 Getting Started

### 📋 Prerequisites

- Node.js 22 or newer
- MongoDB running as a replica set (Atlas works out of the box)
- Redis for BullMQ and the event bus (a shared local Redis is fine as long as `QUEUE_PREFIX` is unique to this project)
- `redis-server` on your PATH to run the tests (they start a temporary instance on a random port)

### 📦 Install and run

```bash
npm install
cp .env.example .env
npm run dev
```

At minimum set `DATABASE_URL` (MongoDB replica set), `REDIS_URL` and `JWT_SECRET` (32 or more characters) in `.env`; every other variable has a default. Open `http://localhost:3000/health` to check the server is running.

The API and the background worker are two separate processes, so run them in two terminals (`npm run dev` and `npm run dev:worker`). In production run `npm start` and `npm run start:worker` as two services that share the same `REDIS_URL` and `QUEUE_PREFIX`.

**Sending email.** Registration queues a verification email, and the **worker** sends it, so `npm run dev:worker` must be running. By default `MAIL_TRANSPORT=log` only writes the email to the worker log. To send through Gmail, turn on 2-Step Verification for the account, create an App Password at <https://myaccount.google.com/apppasswords>, and set `MAIL_TRANSPORT=gmail`, `GMAIL_USER` and `GMAIL_APP_PASSWORD` in `.env` (never commit or share them). Personal Gmail is limited to roughly 500 recipients per day and is meant for early development only. The confirmation link points to `FRONTEND_URL/verify-email?token=...`. That page must read the token, send it with `POST /api/v1/auth/verify-email` (a POST, so mail scanners cannot consume the token), and remove it from the URL; the frontend page is not built yet.

Current auth endpoints (under `/api/v1/auth`): `POST /register`, `POST /verify-email`, `POST /resend-verification`, `POST /login` (returns `403 EMAIL_NOT_VERIFIED` until the email is confirmed), `POST /refresh`, `GET /me`, `POST /logout`, `POST /logout-all`.

**Refresh tokens.** Sign-in (password or Google) sets an `access` cookie (15 minutes) and a `refresh` cookie (30 days sliding, 90 days absolute). When an API call returns `401`, call `POST /api/v1/auth/refresh` once (one refresh at a time across tabs), then retry the original request once. A refresh token works exactly once: every refresh returns a new pair. `409 REFRESH_CONFLICT` means another tab just refreshed, so retry with the cookies the browser now holds. `401` from `/refresh` means the session is over; send the user to the login page. Reusing an already-rotated token after `REFRESH_GRACE_SECONDS` revokes the whole session as a theft signal.

**Google sign-in.** `GET /api/v1/auth/google/start[?returnTo=/path]` redirects the browser to Google (authorization-code flow with PKCE); Google returns to `GET /api/v1/auth/google/callback`, which sets the session cookies and always answers with a `302` to the frontend: success goes to `FRONTEND_URL` + `returnTo` (default `/`), failure goes to `FRONTEND_URL/login?error=<code>` with `cancelled`, `invalid_state`, `google_failed`, `email_unverified`, `account_conflict` or `server_error`. Start the flow from a normal link or `window.location` (not `fetch`). If Google is not configured, `start` returns `503`. Setup: create a Web OAuth client in Google Cloud Console, register `http://localhost:3000/api/v1/auth/google/callback` as an authorized redirect URI, add yourself as a test user while the consent screen is in Testing, and put the client ID and secret only in `.env`.

Account rules: a Google account is identified by its `sub`, never by email alone. An existing account is linked only if its email is already verified. An unverified password account with the same email loses its password and sessions when Google proves the email, then signs in via Google. An account already linked to a different Google `sub` is refused.

### 📜 Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the server with live reload (tsx) |
| `npm run build` | Compile TypeScript and copy `.graphql` files to `dist/` |
| `npm start` | Run the compiled server from `dist/` |
| `npm run dev:worker` / `npm run start:worker` | Run the background job worker as its own process (the API does not run workers unless `RUN_WORKERS=true`) |
| `npm test` | Run the tests against an in-memory MongoDB replica set (the first run downloads a `mongod` binary) |

## ⚙️ Environment Variables

Copy `.env.example` to `.env`. The server will refuse to start when a required variable is missing or invalid.

| Variable | Purpose |
| --- | --- |
| `NODE_ENV`, `PORT` | Runtime mode and port |
| `DATABASE_URL` | MongoDB connection string (replica set required) |
| `REDIS_URL`, `QUEUE_PREFIX`, `RUN_WORKERS` | Redis connection for BullMQ and the event bus, key prefix for every queue, and whether the API also runs workers in its own process (default `false`; the worker is a separate process) |
| `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE` | Access token signing and validation |
| `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`, `SESSION_MAX_AGE`, `REFRESH_GRACE_SECONDS` | Session lifetimes |
| `CORS_ORIGINS`, `TRUST_PROXY` | Allowed origins and reverse proxy setting |
| `COOKIE_SAMESITE`, `AUTH_RATE_LIMIT` | Auth cookie SameSite mode and sign-in/sign-up attempts per IP per 15 minutes |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google sign-in (redirect flow with PKCE). Optional: leave unset to disable it. ID and secret must be set together; the redirect URI defaults to `http://localhost:$PORT/api/v1/auth/google/callback` and must be registered exactly in Google Cloud Console |
| `UPLOAD_DIR`, `API_URL` | Local file storage and public API URL |
| `LOG_LEVEL` | Logging verbosity |
| `MAIL_TRANSPORT`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `MAIL_FROM` | Email delivery: `log` (default, nothing is sent) or `gmail` (SMTP with an App Password; required in production) |
| `FRONTEND_URL`, `EMAIL_VERIFY_TTL` | Base URL used to build links in emails, and how long a verification link stays valid (default `24h`) |

## 🗺️ Roadmap

- [x] Project structure, tooling and dependencies
- [x] Environment validation, logging, error handling
- [x] Email and password sign-up, sign-in, sign-out (email verification pending)
- [x] Refresh token rotation and sign-out everywhere
- [x] Google sign-in (backend redirect flow)
- [ ] Cards, operation API and permissions
- [ ] Publishing and public card endpoints
- [ ] Image uploads
- [ ] Real-time collaboration over WebSocket
- [x] Background job infrastructure (Redis and BullMQ)
- [x] Verification email sending (Gmail SMTP through the background worker)
- [x] Email confirmation, resend verification and the unverified-login gate
- [ ] Password reset
- [ ] Templates
- [ ] MCP server
