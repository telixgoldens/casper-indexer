const db = require('./db');
require('dotenv').config();

let EventSourceImpl = globalThis.EventSource || null;
if (!EventSourceImpl) {
  try {
    const _es = require('eventsource');
    EventSourceImpl = _es && (_es.default || _es);
  } catch (e) {
    EventSourceImpl = null;
  }
}
if (!EventSourceImpl) {
  console.error("EventSource is not available in this Node environment.");
  console.error("Install a polyfill and retry:");
  console.error("  cd backend/my-indexer && npm install eventsource --save");
  throw new Error("Missing EventSource implementation. Install 'eventsource' and retry.");
}

const startWatcher = () => {
  console.log("Indexer Watcher Started...");

  const url = process.env.NODE_URL || "http://159.65.203.12:9999/events/main";
  
  function createEventSource(u) {
    if (typeof EventSourceImpl === 'function') {
      try { return new EventSourceImpl(u); } catch (e) { /* fallback */ }
    }

    if (EventSourceImpl && typeof EventSourceImpl.EventSource === 'function') {
      try { return new EventSourceImpl.EventSource(u); } catch (e) { /* fallback */ }
    }
    if (EventSourceImpl && EventSourceImpl.default) {
      if (typeof EventSourceImpl.default === 'function') {
        try { return new EventSourceImpl.default(u); } catch (e) { /* fallback */ }
      }
      if (EventSourceImpl.default.EventSource && typeof EventSourceImpl.default.EventSource === 'function') {
        try { return new EventSourceImpl.default.EventSource(u); } catch (e) { /* fallback */ }
      }
    }

    console.error('Unable to construct EventSource from loaded module. Type:', typeof EventSourceImpl);
    console.error('Loaded keys:', EventSourceImpl && Object.keys(EventSourceImpl));
    throw new Error("Loaded EventSource implementation is not constructible. Try installing the 'eventsource' package (npm install eventsource).");
  }

  const es = createEventSource(url);

  console.log(`Connecting to Event Stream at: ${url}`);

  es.onopen = () => {
    console.log("Connection to Blockchain Event Stream Open!");
  };

  es.onerror = (err) => {
    console.log("Event Stream Connection Error (will retry)...");
  };

  es.addEventListener('DeployProcessed', async (event) => {
    try {
      const body = JSON.parse(event.data);
      const deploy = body.DeployProcessed;

      if (!deploy.execution_result.Success) return;

      const session = deploy.deploy_session;
      let args = null;
      
      if (session.StoredContractByHash) {
        args = session.StoredContractByHash.args;
      } else if (session.ModuleBytes) {
        args = session.ModuleBytes.args;
      }

      if (args) {
        const daoIdArg = args.find(a => a[0] === 'dao_id');
        const choiceArg = args.find(a => a[0] === 'choice');
        const proposalIdArg = args.find(a => a[0] === 'proposal_id');

        if (daoIdArg && choiceArg) {
          console.log("REAL VOTE DETECTED ON CHAIN!");
          
          const daoId = daoIdArg[1].parsed;
          const choice = choiceArg[1].parsed === 'true' || choiceArg[1].parsed === true;
          const proposalId = proposalIdArg ? proposalIdArg[1].parsed : "1";
          const voter = deploy.account;
          const hash = deploy.deploy_hash;
          
          console.log(`  DAO ID: ${daoId}, Proposal: ${proposalId}, Choice: ${choice ? 'YES' : 'NO'}, Voter: ${voter}`);
          
          db.run(
            "INSERT OR IGNORE INTO votes (deploy_hash, dao_id, proposal_id, voter_address, choice) VALUES (?, ?, ?, ?, ?)",
            [hash, daoId, proposalId, voter, choice ? 1 : 0],
            (err) => {
              if (err) {
                console.error("Error inserting vote:", err);
              } else {
                console.log("Vote stored in database");
              }
            }
          );
        }
      }
    } catch (err) {
      console.error(" Error parsing event:", err.message);
    }
  });

  
  console.log("Watcher ready - indexing real blockchain votes only");
};

module.exports = { startWatcher };