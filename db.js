const { Pool } = require('pg');
const connectionString = process.env.DATABASE_URL || 'postgresql://localhost/casper_dao_dev';
const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('PostgreSQL connection error:', err);
  } else {
    console.log('Connected to PostgreSQL database');
  }
});

const initializeDatabase = async () => {
  const client = await pool.connect();
  
  try {
    console.log('Initializing database schema...');
    await client.query('DROP TABLE IF EXISTS votes CASCADE');
    await client.query('DROP TABLE IF EXISTS proposals CASCADE');
    await client.query('DROP TABLE IF EXISTS daos CASCADE');
    console.log('Old tables dropped (if existed)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS daos (
        id SERIAL PRIMARY KEY,
        dao_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        token_address TEXT NOT NULL,
        token_type TEXT NOT NULL,
        creator TEXT NOT NULL,
        deploy_hash TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('DAOs table ready');
    await client.query(`
      CREATE TABLE IF NOT EXISTS proposals (
        id SERIAL PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        dao_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        voting_duration BIGINT NOT NULL,
        creator TEXT NOT NULL,
        deploy_hash TEXT,
        status TEXT DEFAULT 'active',
        ai_summary TEXT,
        yes_votes INTEGER DEFAULT 0,
        no_votes INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(dao_id, proposal_id)
      )
    `);
    console.log('Proposals table ready');
    await client.query(`
      CREATE TABLE IF NOT EXISTS votes (
        id SERIAL PRIMARY KEY,
        deploy_hash TEXT UNIQUE,
        dao_id TEXT,
        proposal_id TEXT,
        voter_address TEXT,
        choice BOOLEAN,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Votes table ready');
    console.log('Database initialization complete!');

  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
    client.release();
  }
};

initializeDatabase();

module.exports = pool;