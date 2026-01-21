const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbPath = path.resolve(__dirname, "votes.db");
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Could not connect to SQLite database", err);
  } else {
    console.log("Connected to SQLite database");
  }
});

db.serialize(() => {
  db.run(
    `
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deploy_hash TEXT UNIQUE,
      dao_id TEXT,
      proposal_id TEXT,
      voter_address TEXT,
      choice BOOLEAN,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `,
    (err) => {
      if (err) console.error("Error creating votes table:", err);
    },
  );
  db.run(
    `
  CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id TEXT NOT NULL,
    dao_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    voting_duration INTEGER NOT NULL,
    creator TEXT NOT NULL,
    deploy_hash TEXT,
    status TEXT DEFAULT 'active',
    ai_summary TEXT,
    yes_votes INTEGER DEFAULT 0,
    no_votes INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(dao_id, proposal_id)
  )
`,
    (err) => {
      if (err) {
        console.error("Error creating proposals table:", err);
      } else {
        console.log("Proposals table ready");
      }
    },
  );

  db.run(
    `
    CREATE TABLE IF NOT EXISTS daos (
      dao_id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      creator TEXT,
      deploy_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `,
    (err) => {
      if (err) console.error("Error creating daos table:", err);
    },
  );
});

module.exports = db;
