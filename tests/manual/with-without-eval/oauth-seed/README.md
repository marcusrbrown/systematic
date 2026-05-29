# express-login-starter

A minimal Express app with email-based login backed by PostgreSQL and `express-session`.

## Setup

```bash
npm install
export DATABASE_URL=postgres://localhost/mydb
export SESSION_SECRET=change-me
npm start
```

The server listens on `PORT` (default 3000).

## Routes

| Method | Path      | Description                                      |
|--------|-----------|--------------------------------------------------|
| GET    | `/`       | Shows login status                               |
| POST   | `/login`  | Accepts `email` (form body), sets session userId |
| POST   | `/logout` | Destroys the session                             |

## Database

Run `db/schema.sql` against your Postgres database to create the `users` table.
