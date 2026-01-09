const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'votes.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Could not connect to SQLite database', err);
  } else {
    console.log('Connected to SQLite database');
  }
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deploy_hash TEXT UNIQUE,
      dao_id TEXT,
      proposal_id TEXT,
      voter_address TEXT,
      choice BOOLEAN,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error("Error creating votes table:", err);
  });
  
  db.run(`
    CREATE TABLE IF NOT EXISTS daos (
      dao_id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      creator TEXT,
      deploy_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error("Error creating daos table:", err);
  });
});

module.exports = db;