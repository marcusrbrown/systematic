CREATE TABLE IF NOT EXISTS users (
  id         bigserial    PRIMARY KEY,
  email      text         UNIQUE NOT NULL,
  created_at timestamptz  NOT NULL DEFAULT now()
);
