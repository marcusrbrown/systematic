const express = require('express')
const session = require('express-session')
const { pool } = require('./db')

const app = express()

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  }),
)

// Existing login: email-only stub (no password yet). Sets req.session.userId.
app.post(
  '/login',
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const { email } = req.body
    const result = await pool.query('SELECT id FROM users WHERE email = $1', [
      email,
    ])
    if (result.rows.length === 0) return res.status(401).send('unknown user')
    req.session.userId = result.rows[0].id
    res.redirect('/')
  },
)

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'))
})

app.get('/', (req, res) => {
  if (!req.session.userId) return res.send('logged out')
  res.send(`logged in as user ${req.session.userId}`)
})

const port = process.env.PORT || 3000
app.listen(port, () => console.log(`listening on ${port}`))

module.exports = app
