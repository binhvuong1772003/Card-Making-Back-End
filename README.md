# 🎴 CardMaking Backend (CMBE)

Backend for **CardMaking**, a web app where people design greeting cards and invitations online, publish them as shareable web pages, and edit them together in real time.

> 🚧 **Status:** early scaffolding. The project structure, tooling and dependencies are in place and a health endpoint runs; the feature modules are placeholders and are being implemented one by one.

## ✨ What is CardMaking?

Users build a card visually: drop text where they want it, pick colors and fonts, add images and shapes, and customize almost everything. A finished card is **published as a web page** (for example `domain.com/thiep/abcxyz`) that anyone can open and share, not a flat image.

## 🧩 Planned Features

- 🎨 **Card editor model**: a card is a JSON document with a canvas and an ordered list of elements (text, image, shape), each with position, size, rotation, opacity and animation.
- 🌐 **Publishing**: separate draft and published snapshot, public URL by slug, unpublish without losing the link, SEO controls (`indexable` flag, sitemap).
- 🤝 **Real-time collaboration**: operation-based editing over WebSocket with the server as the single source of truth, roles (owner, editor, viewer) and invite links.
- 🔐 **Authentication**: Google sign-in, short-lived access tokens with rotating refresh tokens; email and password login comes later.
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
| 🔌 APIs | REST, GraphQL, WebSocket |
| 🧰 Jobs and messaging | Redis + BullMQ |
| ✅ Validation | Zod |
| 🔑 Auth | jose (JWT), google-auth-library, cookie-parser |
| 🛡️ Security | helmet, express-rate-limit |
| 📤 Uploads | multer |
| 🪵 Logging | pino, pino-http |
| 🧪 Testing | Vitest, Supertest, mongodb-memory-server |

GraphQL and WebSocket libraries will be chosen when those modules are implemented.

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
- Redis

### 📦 Install and run

```bash
npm install
cp .env.example .env
npm run dev
```

The current scaffold only needs `PORT`; open `http://localhost:3000/health` to check it is running.

### 📜 Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the server with live reload (tsx) |
| `npm run build` | Compile TypeScript and copy `.graphql` files to `dist/` |
| `npm start` | Run the compiled server from `dist/` |

## ⚙️ Environment Variables

Copy `.env.example` to `.env`. The server will refuse to start when a required variable is missing or invalid.

| Variable | Purpose |
| --- | --- |
| `NODE_ENV`, `PORT` | Runtime mode and port |
| `DATABASE_URL` | MongoDB connection string (replica set required) |
| `REDIS_URL` | Redis connection for BullMQ and the event bus |
| `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE` | Access token signing and validation |
| `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`, `SESSION_MAX_AGE`, `REFRESH_GRACE_SECONDS` | Session lifetimes |
| `CORS_ORIGINS`, `TRUST_PROXY` | Allowed origins and reverse proxy setting |
| `GOOGLE_CLIENT_ID` | Google sign-in |
| `UPLOAD_DIR`, `API_URL` | Local file storage and public API URL |
| `LOG_LEVEL` | Logging verbosity |
| `FRONTEND_URL`, `RESEND_API_KEY`, `MAIL_FROM` | Email flows (when password login is enabled) |

## 🗺️ Roadmap

- [x] Project structure, tooling and dependencies
- [ ] Environment validation, logging, error handling
- [ ] Google sign-in, sessions and refresh token rotation
- [ ] Cards, operation API and permissions
- [ ] Publishing and public card endpoints
- [ ] Image uploads
- [ ] Real-time collaboration over WebSocket
- [ ] Background jobs
- [ ] Email and password login
- [ ] Templates
- [ ] MCP server
