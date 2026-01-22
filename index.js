const express = require("express");
const cors = require("cors");
const pool = require("./db");
require("dotenv").config();

const CasperSDK = require("casper-js-sdk");

const {
  PrivateKey,
  KeyAlgorithm,
  ContractCallBuilder,
  Args,
  CLValue,
  PublicKey,
  serializeArgs,
} = CasperSDK;

const OpenAI = require("openai");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch");
const { log } = require("console");


const RPC_URL = process.env.RPC_URL || "http://65.109.83.79:7777/rpc";
const NETWORK_NAME = "casper-test";
const DAO_CONTRACT_HASH =
  "hash-511efb42d9ae1f6fa233615a9ef730b88387aeb81524e8acc4865a1f08093f75";
const TOKEN_CONTRACT_HASH =
  "hash-92a2dd97639d61dcb8460e512032a7de561f61b735cec478c474afc926123990";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let privateKeyPem;

if (process.env.CASPER_PRIVATE_KEY_BASE64) {
  console.log("Loading keys from base64 env variable");
  privateKeyPem = Buffer.from(
    process.env.CASPER_PRIVATE_KEY_BASE64,
    "base64",
  ).toString("utf-8");
} else if (process.env.CASPER_PRIVATE_KEY) {
  console.log("Loading keys from env variable");
  privateKeyPem = process.env.CASPER_PRIVATE_KEY;
} else {
  console.log("Loading keys from local file");
  const KEYS_PATH = path.join(__dirname, "keys", "secret_key.pem");
  privateKeyPem = fs.readFileSync(KEYS_PATH, "utf-8");
}

const privateKey = PrivateKey.fromPem(privateKeyPem, KeyAlgorithm.ED25519);
const publicKey = privateKey.publicKey;
const FAUCET_AMOUNT = "100000000000";
const FAUCET_COOLDOWN = 24 * 60 * 60 * 1000;
const faucetClaims = new Map();

console.log("Loaded public key:", publicKey.toHex());

async function pollForDaoCreation(
  deployHash,
  daoName,
  description,
  tokenAddress,
  tokenType,
  creator,
) {
  let attempts = 0;
  const maxAttempts = 40;

  console.log(`Started polling for DAO creation: ${daoName}`);

  const interval = setInterval(async () => {
    attempts++;

    try {
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "info_get_deploy",
          params: [deployHash],
        }),
      });

      const result = await response.json();

      if (result.error) {
        if (attempts % 5 === 0) {
          console.log(
            `Attempt ${attempts}/${maxAttempts}: Deploy not found yet...`,
          );
        }
        return;
      }

      const executionResult =
        result.result?.execution_info?.execution_result?.Version2;

      if (executionResult) {
        if (executionResult.error_message) {
          console.error(
            `DAO creation failed: ${executionResult.error_message}`,
          );
          clearInterval(interval);
          return;
        }

        if (executionResult.effects) {
          for (const effect of executionResult.effects) {
            if (effect.kind?.AddKeys) {
              for (const addedKey of effect.kind.AddKeys) {
                if (addedKey.name?.startsWith("event_dao_created_")) {
                  const daoId = addedKey.name.replace("event_dao_created_", "");

                  pool.query(
                    `INSERT INTO daos (dao_id, name, description, token_address, token_type, creator, deploy_hash) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (dao_id) DO UPDATE SET
                    name = EXCLUDED.name,
                    description = EXCLUDED.description,
                    token_address = EXCLUDED.token_address,
                    token_type = EXCLUDED.token_type,
                    creator = EXCLUDED.creator,
                    deploy_hash = EXCLUDED.deploy_hash`,
                    [
                      daoId,
                      daoName,
                      description,
                      tokenAddress,
                      tokenType,
                      creator,
                      deployHash,
                    ],
                    (err) => {
                      if (!err) {
                        console.log(
                          `DAO registered! DAO ID: ${daoId}, Name: ${daoName}`,
                        );
                      } else {
                        console.error("Error saving DAO:", err);
                      }
                    },
                  );

                  clearInterval(interval);
                  return;
                }
              }
            }
          }
        }

        console.log(`Execution completed but no DAO ID found`);
        clearInterval(interval);
      } else {
        if (attempts % 5 === 0) {
          console.log(
            `Attempt ${attempts}/${maxAttempts}: Waiting for execution...`,
          );
        }
      }
    } catch (err) {
      console.error("Polling error:", err.message);
    }

    if (attempts >= maxAttempts) {
      console.log(
        `Stopped polling for DAO creation (timeout after ${maxAttempts} attempts)`,
      );
      console.log(
        `Check deploy manually: https://testnet.cspr.live/deploy/${deployHash}`,
      );
      clearInterval(interval);
    }
  }, 4000);
}

async function pollForVoteExecution(
  deployHash,
  daoId,
  proposalId,
  choice,
  voter,
) {
  let attempts = 0;
  const maxAttempts = 30;

  console.log(
    `Started polling for vote execution: DAO ${daoId}, Proposal ${proposalId}`,
  );

  const interval = setInterval(async () => {
    attempts++;

    try {
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "info_get_deploy",
          params: [deployHash],
        }),
      });

      const result = await response.json();

      if (result.error) {
        console.log(`Vote attempt ${attempts}: Deploy not found yet...`);
        return;
      }

      const executionResult =
        result.result?.execution_info?.execution_result?.Version2;

      if (executionResult) {
        if (executionResult.error_message) {
          console.error(
            `Vote execution failed: ${executionResult.error_message}`,
          );
          clearInterval(interval);
          return;
        }

        pool.query(
          `INSERT INTO votes (deploy_hash, dao_id, proposal_id, voter_address, choice) 
   VALUES ($1, $2, $3, $4, $5)
   ON CONFLICT (deploy_hash) DO NOTHING`,
          [deployHash, daoId, proposalId, voter, choice ? 1 : 0],
          (err) => {
            if (!err) {
              console.log(
                `Vote stored! DAO: ${daoId}, Proposal: ${proposalId}, Choice: ${choice ? "YES" : "NO"}, Voter: ${voter.substring(0, 10)}...`,
              );
            } else {
              console.error("Error saving vote:", err);
            }
          },
        );

        clearInterval(interval);
        return;
      } else {
        console.log(`Vote attempt ${attempts}: Waiting for execution...`);
      }
    } catch (err) {
      console.error("Error polling for vote:", err.message);
    }

    if (attempts >= maxAttempts) {
      console.log(`Stopped polling for vote execution (timeout)`);
      clearInterval(interval);
    }
  }, 4000);
}

async function pollForProposalCreation(
  deployHash,
  daoId,
  title,
  description,
  votingDuration,
  creator,
) {
  let attempts = 0;
  const maxAttempts = 30;

  console.log(`Started polling for proposal creation: DAO ${daoId}`);

  const interval = setInterval(async () => {
    attempts++;

    try {
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "info_get_deploy",
          params: [deployHash],
        }),
      });

      const result = await response.json();

      if (result.error) {
        if (attempts % 5 === 0) {
          console.log(`Proposal attempt ${attempts}: Deploy not found yet...`);
        }
        return;
      }

      const executionResult =
        result.result?.execution_info?.execution_result?.Version2;

      if (executionResult) {
        if (executionResult.error_message) {
          console.error(
            `Proposal creation failed: ${executionResult.error_message}`,
          );
          clearInterval(interval);
          return;
        }
        let proposalId = null;

        if (executionResult.effects) {
          for (const effect of executionResult.effects) {
            if (effect.kind?.AddKeys) {
              for (const addedKey of effect.kind.AddKeys) {
                if (addedKey.name?.startsWith("event_proposal_created_")) {
                  const parts = addedKey.name
                    .replace("event_proposal_created_", "")
                    .split("_");
                  proposalId = parts[1];
                  break;
                }
              }
            }
            if (proposalId) break;
          }
        }

        if (proposalId) {
          pool.query(
            `INSERT INTO proposals (proposal_id, dao_id, title, description, voting_duration, creator, deploy_hash, status) 
   VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
   ON CONFLICT (dao_id, proposal_id) DO NOTHING`,
            [
              proposalId,
              daoId,
              title,
              description,
              votingDuration,
              creator,
              deployHash,
            ],
            (err) => {
              if (!err) {
                console.log(
                  `Proposal stored! DAO: ${daoId}, Proposal ID: ${proposalId}`,
                );
              } else {
                console.error("Error saving proposal:", err);
              }
            },
          );
        } else {
          console.log("Proposal created but ID not found in effects");
        }

        clearInterval(interval);
        return;
      } else {
        if (attempts % 5 === 0) {
          console.log(`Proposal attempt ${attempts}: Waiting for execution...`);
        }
      }
    } catch (err) {
      console.error("Error polling for proposal:", err.message);
    }

    if (attempts >= maxAttempts) {
      console.log(`Stopped polling for proposal creation (timeout)`);
      clearInterval(interval);
    }
  }, 4000);
}

async function putDeployViaRPC(transaction) {
  let deploy;

  if (transaction.getDeploy && typeof transaction.getDeploy === "function") {
    deploy = transaction.getDeploy();
  } else {
    deploy = transaction;
  }

  let sessionArgsJson = [];
  let paymentArgsJson = [];

  try {
    if (deploy.session?.storedContractByHash?.args) {
      sessionArgsJson = serializeArgs(deploy.session.storedContractByHash.args);
    }
  } catch (e) {
    console.error("Error serializing session args:", e.message);
  }

  try {
    if (deploy.payment?.moduleBytes?.args) {
      paymentArgsJson = serializeArgs(deploy.payment.moduleBytes.args);
    }
  } catch (e) {
    console.error("Error serializing payment args:", e.message);
  }

  const deployJson = {
    hash: deploy.hash?.value || deploy.hash,
    header: {
      account: deploy.header.account.value || deploy.header.account,
      timestamp: deploy.header.timestamp.toJSON
        ? deploy.header.timestamp.toJSON()
        : deploy.header.timestamp,
      ttl: deploy.header.ttl.toJSON
        ? deploy.header.ttl.toJSON()
        : deploy.header.ttl,
      gas_price: deploy.header.gasPrice,
      body_hash: deploy.header.bodyHash?.value || deploy.header.bodyHash,
      dependencies: [],
      chain_name: deploy.header.chainName,
    },
    payment: {
      ModuleBytes: {
        module_bytes: "",
        args: paymentArgsJson,
      },
    },
    session: {
      StoredContractByHash: {
        hash:
          deploy.session.storedContractByHash.hash?.value ||
          deploy.session.storedContractByHash.hash,
        entry_point: deploy.session.storedContractByHash.entryPoint,
        args: sessionArgsJson,
      },
    },
    approvals: deploy.approvals.map((a) => ({
      signer: a.signer.value || a.signer,
      signature: a.signature.value || a.signature,
    })),
  };

  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "account_put_deploy",
      params: { deploy: deployJson },
    }),
  });

  const result = await response.json();

  if (result.error) {
    console.error("RPC Error:", result.error);
    throw new Error(`RPC Error: ${result.error.message}`);
  }

  console.log("Deploy submitted! Hash:", result.result.deploy_hash);

  return result.result.deploy_hash;
}

const app = express();
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://casper-dao.vercel.app",
      "https://casper-dao-frontend.vercel.app",
    ],
    credentials: true,
  }),
);
app.use(express.json());

app.post("/prepare-vote", async (req, res) => {
  try {
    const { daoId, proposalId, choice, userPublicKey } = req.body;

    if (
      !daoId ||
      proposalId === undefined ||
      choice === undefined ||
      !userPublicKey
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    console.log("Preparing vote deploy for user to sign");
    console.log("User:", userPublicKey);
    console.log(
      "DAO:",
      daoId,
      "Proposal:",
      proposalId,
      "Choice:",
      choice ? "YES" : "NO",
    );
    console.log("Vote arguments being sent:");
    console.log("  dao_id:", daoId, "(BigInt:", BigInt(daoId).toString() + ")");
    console.log(
      "  proposal_id:",
      proposalId,
      "(BigInt:",
      BigInt(proposalId).toString() + ")",
    );
    console.log("  Proposal key that will be used:", `${daoId}_${proposalId}`);
    const argsMap = {
      dao_id: CLValue.newCLUint64(BigInt(daoId)),
      proposal_id: CLValue.newCLUint64(BigInt(proposalId)),
      choice: CLValue.newCLValueBool(choice),
    };

    const args = Args.fromMap(argsMap);
    const userPubKey = PublicKey.fromHex(userPublicKey);
    const builder = new ContractCallBuilder();

    builder
      .byHash(DAO_CONTRACT_HASH.slice(5))
      .entryPoint("vote")
      .from(userPubKey)
      .chainName(NETWORK_NAME)
      .payment(150_000_000_000)
      .ttl(1800000)
      .runtimeArgs(args);

    const transaction = builder.buildFor1_5();
    const deploy = transaction.getDeploy
      ? transaction.getDeploy()
      : transaction;

    let sessionArgsJson = [];
    let paymentArgsJson = [];

    if (deploy.session?.storedContractByHash?.args) {
      sessionArgsJson = serializeArgs(deploy.session.storedContractByHash.args);
    }

    if (deploy.payment?.moduleBytes?.args) {
      paymentArgsJson = serializeArgs(deploy.payment.moduleBytes.args);
    }

    const deployJson = {
      hash: deploy.hash?.value || deploy.hash,
      header: {
        account: deploy.header.account.value || deploy.header.account,
        timestamp: deploy.header.timestamp.toJSON
          ? deploy.header.timestamp.toJSON()
          : deploy.header.timestamp,
        ttl: deploy.header.ttl.toJSON
          ? deploy.header.ttl.toJSON()
          : deploy.header.ttl,
        gas_price: deploy.header.gasPrice,
        body_hash: deploy.header.bodyHash?.value || deploy.header.bodyHash,
        dependencies: [],
        chain_name: deploy.header.chainName,
      },
      payment: {
        ModuleBytes: {
          module_bytes: "",
          args: paymentArgsJson,
        },
      },
      session: {
        StoredContractByHash: {
          hash:
            deploy.session.storedContractByHash.hash?.value ||
            deploy.session.storedContractByHash.hash,
          entry_point: deploy.session.storedContractByHash.entryPoint,
          args: sessionArgsJson,
        },
      },
      approvals: [],
    };

    res.json({
      deployJson,
      message: "Deploy ready for user to sign with Casper Wallet",
    });
  } catch (err) {
    console.error("Prepare vote error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/submit-signed-deploy", async (req, res) => {
  try {
    const { signedDeploy, deployJson, daoId, proposalId, choice, daoData } =
      req.body;

    if (!signedDeploy || !deployJson) {
      return res
        .status(400)
        .json({ error: "Missing signedDeploy or deployJson" });
    }

    console.log("Submitting user-signed deploy...");
    console.log("DAO ID from request:", daoId);
    console.log("Choice from request:", choice);

    const walletResponse =
      typeof signedDeploy === "string"
        ? JSON.parse(signedDeploy)
        : signedDeploy;
    const originalDeploy =
      typeof deployJson === "string" ? JSON.parse(deployJson) : deployJson;
    const accountHex = originalDeploy.header.account;
    let algorithmPrefix;

    if (accountHex.startsWith("01")) {
      algorithmPrefix = "01";
      console.log("Detected Ed25519 key");
    } else if (accountHex.startsWith("02")) {
      algorithmPrefix = "02";
      console.log("Detected Secp256K1 key");
    } else {
      throw new Error("Unknown key algorithm");
    }

    let signatureHex = walletResponse.signatureHex;
    if (!signatureHex.startsWith("01") && !signatureHex.startsWith("02")) {
      signatureHex = algorithmPrefix + signatureHex;
    }

    const approval = {
      signer: originalDeploy.header.account,
      signature: signatureHex,
    };

    const finalDeploy = {
      hash: originalDeploy.hash,
      header: originalDeploy.header,
      payment: originalDeploy.payment,
      session: originalDeploy.session,
      approvals: [approval],
    };

    console.log("Submitting to RPC...");

    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "account_put_deploy",
        params: { deploy: finalDeploy },
      }),
    });

    const result = await response.json();

    if (result.error) {
      console.error("RPC Error:", result.error);
      throw new Error(`RPC Error: ${result.error.message}`);
    }

    const deployHash = result.result.deploy_hash;
    console.log("User-signed deploy submitted! Hash:", deployHash);

    const creator = originalDeploy.header?.account;

    if (daoData) {
      const { name, description, tokenAddress, tokenType } = daoData;
      console.log(`Starting polling for DAO creation: ${name}`);
      pollForDaoCreation(
        deployHash,
        name,
        description,
        tokenAddress,
        tokenType,
        creator,
      );
    } else if (choice !== undefined && daoId && proposalId && creator) {
      console.log(
        `Starting polling: DAO ${daoId}, Proposal ${proposalId}, Choice: ${choice ? "YES" : "NO"}`,
      );
      pollForVoteExecution(deployHash, daoId, proposalId, choice, creator);
    } else if (req.body.proposalData) {
      const { title, description, votingDuration } = req.body.proposalData;
      console.log(`Starting polling for proposal creation: DAO ${daoId}`);
      pollForProposalCreation(
        deployHash,
        daoId,
        title,
        description,
        votingDuration,
        creator,
      );
    }

    res.json({
      deployHash,
      message: "Deploy submitted successfully",
    });
  } catch (err) {
    console.error("Submit signed deploy error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/votes/:proposalId", (req, res) => {
  const { proposalId } = req.params;

  pool.query(
    "SELECT * FROM votes WHERE proposal_id = $1 ORDER BY timestamp DESC LIMIT 100",
    [proposalId],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ votes: result.rows });
    },
  );
});

app.get("/stats/:daoId/:proposalId", async (req, res) => {
  try {
    const { daoId, proposalId } = req.params;

    const yesResult = await pool.query(
      "SELECT COUNT(*) as count FROM votes WHERE dao_id = $1 AND proposal_id = $2 AND choice = true",
      [daoId, proposalId]
    );

    const noResult = await pool.query(
      "SELECT COUNT(*) as count FROM votes WHERE dao_id = $1 AND proposal_id = $2 AND choice = false",
      [daoId, proposalId]
    );

    const yesCount = parseInt(yesResult.rows[0].count) || 0;
    const noCount = parseInt(noResult.rows[0].count) || 0;

    res.json({
      yes: yesCount,
      no: noCount,
      total: yesCount + noCount,
    });
  } catch (err) {
    console.error("Error fetching stats:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/test-dao-creation", async (req, res) => {
  try {
    console.log("Testing DAO creation on Render...");
    console.log("RPC_URL:", RPC_URL);
    console.log("Public key:", publicKey.toHex());
    console.log("DAO contract:", DAO_CONTRACT_HASH);
    console.log("Token contract:", TOKEN_CONTRACT_HASH);

    const testName = "Render Test DAO " + Date.now();

    const rawHash = TOKEN_CONTRACT_HASH.startsWith("hash-")
      ? TOKEN_CONTRACT_HASH.slice(5)
      : TOKEN_CONTRACT_HASH.replace(/^0x/, "");

    const typePrefix = Buffer.from([1]);
    const hashBuffer = Buffer.from(rawHash, "hex");
    const keyBuffer = Buffer.concat([typePrefix, hashBuffer]);

    const argsMap = {
      name: CLValue.newCLString(testName),
      token_address: CLValue.newCLByteArray(Uint8Array.from(keyBuffer)),
      token_type: CLValue.newCLString("u256_address"),
    };

    const args = Args.fromMap(argsMap);
    const builder = new ContractCallBuilder();

    builder
      .byHash(DAO_CONTRACT_HASH.slice(5))
      .entryPoint("create_dao")
      .from(publicKey)
      .chainName(NETWORK_NAME)
      .payment(300_000_000_000)
      .ttl(1800000)
      .runtimeArgs(args);

    const transaction = builder.buildFor1_5();
    transaction.sign(privateKey);

    const deployHash = await putDeployViaRPC(transaction);

    res.json({
      success: true,
      deployHash,
      message: "Test DAO creation submitted from Render",
      cspr_live: `https://testnet.cspr.live/deploy/${deployHash}`,
    });
  } catch (err) {
    console.error("Test DAO error:", err);
    res.status(500).json({
      success: false,
      error: err.message,
      stack: err.stack,
    });
  }
});

app.post("/prepare-create-dao", async (req, res) => {
  try {
    const { name, description, userPublicKey } = req.body;

    if (!name || !userPublicKey) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    console.log("Preparing create_dao deploy for user to sign");
    console.log("User:", userPublicKey);
    console.log("DAO name:", name);
    console.log("Token contract:", TOKEN_CONTRACT_HASH);

    const rawHash = TOKEN_CONTRACT_HASH.startsWith("hash-")
      ? TOKEN_CONTRACT_HASH.slice(5)
      : TOKEN_CONTRACT_HASH.replace(/^0x/, "");

    const typePrefix = Buffer.from([1]);
    const hashBuffer = Buffer.from(rawHash, "hex");
    const keyBuffer = Buffer.concat([typePrefix, hashBuffer]);

    console.log("Key buffer length:", keyBuffer.length);

    const userPubKey = PublicKey.fromHex(userPublicKey);
    const argsMap = {
      name: CLValue.newCLString(name),
      token_address: CLValue.newCLByteArray(Uint8Array.from(keyBuffer)),
      token_type: CLValue.newCLString("u256_address"),
    };

    console.log("Args created");

    const args = Args.fromMap(argsMap);
    const builder = new ContractCallBuilder();

    builder
      .byHash(DAO_CONTRACT_HASH.slice(5))
      .entryPoint("create_dao")
      .from(userPubKey)
      .chainName(NETWORK_NAME)
      .payment(300_000_000_000)
      .ttl(1800000)
      .runtimeArgs(args);

    console.log("Transaction builder configured");

    const transaction = builder.buildFor1_5();
    const deploy = transaction.getDeploy
      ? transaction.getDeploy()
      : transaction;

    console.log("Transaction built (not signed yet - user will sign)");

    let sessionArgsJson = [];
    let paymentArgsJson = [];

    if (deploy.session?.storedContractByHash?.args) {
      sessionArgsJson = serializeArgs(deploy.session.storedContractByHash.args);
    }

    if (deploy.payment?.moduleBytes?.args) {
      paymentArgsJson = serializeArgs(deploy.payment.moduleBytes.args);
    }

    const deployJson = {
      hash: deploy.hash?.value || deploy.hash,
      header: {
        account: deploy.header.account.value || deploy.header.account,
        timestamp: deploy.header.timestamp.toJSON
          ? deploy.header.timestamp.toJSON()
          : deploy.header.timestamp,
        ttl: deploy.header.ttl.toJSON
          ? deploy.header.ttl.toJSON()
          : deploy.header.ttl,
        gas_price: deploy.header.gasPrice,
        body_hash: deploy.header.bodyHash?.value || deploy.header.bodyHash,
        dependencies: [],
        chain_name: deploy.header.chainName,
      },
      payment: {
        ModuleBytes: {
          module_bytes: "",
          args: paymentArgsJson,
        },
      },
      session: {
        StoredContractByHash: {
          hash:
            deploy.session.storedContractByHash.hash?.value ||
            deploy.session.storedContractByHash.hash,
          entry_point: deploy.session.storedContractByHash.entryPoint,
          args: sessionArgsJson,
        },
      },
      approvals: [],
    };

    console.log("Deploy prepared for user signature");

    res.json({
      deployJson,
      message: "Deploy ready for user to sign with Casper Wallet",
    });
  } catch (err) {
    console.error("Prepare create DAO error:", err);
    console.error("Stack:", err.stack);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.get("/verify-dao/:daoId", async (req, res) => {
  try {
    const { daoId } = req.params;

    console.log("Verifying DAO on chain:", daoId);

    const blockResponse = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "chain_get_block",
        params: [],
      }),
    });

    const blockResult = await blockResponse.json();

    if (blockResult.error) {
      throw new Error(`Block Error: ${blockResult.error.message}`);
    }

    const stateRootHash =
      blockResult.result?.block_with_signatures?.block?.Version2?.header
        ?.state_root_hash;

    if (!stateRootHash) {
      throw new Error("Could not get state root hash from block");
    }

    console.log(
      " Got state root hash:",
      stateRootHash.substring(0, 20) + "...",
    );

    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "state_get_item",
        params: {
          state_root_hash: stateRootHash,
          key: DAO_CONTRACT_HASH,
          path: [],
        },
      }),
    });

    const result = await response.json();

    if (result.error) {
      console.error("State get item error:", result.error);
      throw new Error(`RPC Error: ${result.error.message}`);
    }

    const namedKeys = result.result?.stored_value?.Contract?.named_keys || [];

    console.log("Total named keys in contract:", namedKeys.length);

    const allDaoKeys = namedKeys
      .filter((k) => k.name.startsWith("event_dao_created_"))
      .map((k) => ({
        name: k.name,
        dao_id: k.name.replace("event_dao_created_", ""),
      }));

    console.log("Found DAO keys:", allDaoKeys.length);
    console.log("DAO IDs:", allDaoKeys.map((k) => k.dao_id).join(", "));

    const daoEventKey = `event_dao_created_${daoId}`;
    const daoKey = namedKeys.find((key) => key.name === daoEventKey);

    if (daoKey) {
      res.json({
        exists: true,
        daoId,
        message: `DAO ${daoId} exists on chain!`,
        allDaosOnChain: allDaoKeys,
      });
    } else {
      res.json({
        exists: false,
        daoId,
        message: `DAO ${daoId} NOT found on chain`,
        allDaosOnChain: allDaoKeys,
        hint:
          allDaoKeys.length > 0
            ? `Try voting with one of these DAO IDs: ${allDaoKeys.map((k) => k.dao_id).join(", ")}`
            : "No DAOs exist yet. Create one first!",
      });
    }
  } catch (err) {
    console.error("Error verifying DAO:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/check-voter-balance/:voterPublicKey", async (req, res) => {
  try {
    const { voterPublicKey } = req.params;

    console.log("Checking token balance for:", voterPublicKey);
    res.json({
      message: "To vote, users need governance tokens",
      voterPublicKey,
      tokenContract: TOKEN_CONTRACT_HASH,
      note: "Make sure the voter has tokens from this contract to participate in voting",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/manual-check-vote", async (req, res) => {
  try {
    const { deployHash } = req.body;

    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "info_get_deploy",
        params: [deployHash],
      }),
    });

    const result = await response.json();
    const executionResult =
      result.result?.execution_info?.execution_result?.Version2;

    if (executionResult && !executionResult.error_message) {
      res.json({ success: true, message: "Vote executed successfully" });
    } else {
      res.json({ success: false, error: executionResult?.error_message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/daos", (req, res) => {
  pool.query("SELECT * FROM daos ORDER BY created_at DESC", (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ daos: result.rows });
  });
});

app.get("/all-votes", (req, res) => {
  pool.query("SELECT * FROM votes ORDER BY timestamp DESC", (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ votes: result.rows });
  });
});

app.get("/clear-simulated-votes", (req, res) => {
  pool.query(
    "DELETE FROM votes WHERE deploy_hash LIKE '0x%' AND length(deploy_hash) < 20",
    (err) => {
      if (err) return res.status(500).json({ error: err.message });

      pool.query("SELECT COUNT(*) as count FROM votes", (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
          message: "Simulated votes cleared",
          remainingVotes: result.rows[0].count,
        });
      });
    },
  );
});

app.get("/debug/test-rpc", async (req, res) => {
  try {
    console.log("Testing RPC connection from Render...");
    console.log("RPC_URL:", RPC_URL);

    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "info_get_status",
        params: [],
      }),
    });

    const result = await response.json();

    res.json({
      rpc_url: RPC_URL,
      rpc_response: result,
      success: !result.error,
    });
  } catch (err) {
    res.status(500).json({
      rpc_url: RPC_URL,
      error: err.message,
      stack: err.stack,
    });
  }
});

app.get("/extract-dao-id/:deployHash", async (req, res) => {
  try {
    const { deployHash } = req.params;

    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "info_get_deploy",
        params: [deployHash],
      }),
    });

    const result = await response.json();

    if (result.error) {
      throw new Error(`RPC Error: ${result.error.message}`);
    }

    const executionResult =
      result.result?.execution_info?.execution_result?.Version2;

    if (!executionResult) {
      return res
        .status(404)
        .json({ error: "Deploy not executed yet. Wait and try again." });
    }

    let daoId = null;

    if (executionResult.effects) {
      for (const effect of executionResult.effects) {
        if (effect.kind?.AddKeys) {
          for (const addedKey of effect.kind.AddKeys) {
            if (addedKey.name?.startsWith("event_dao_created_")) {
              daoId = addedKey.name.replace("event_dao_created_", "");
              break;
            }
          }
        }
        if (daoId) break;
      }
    }

    if (!daoId) {
      return res
        .status(404)
        .json({ error: "DAO ID not found in execution effects" });
    }

    res.json({ daoId, deployHash });
  } catch (err) {
    console.error("Error extracting dao_id:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/has-voted/:daoId/:voterPublicKey", (req, res) => {
  const { daoId, voterPublicKey } = req.params;

  pool.query(
    "SELECT COUNT(*) as count FROM votes WHERE dao_id = $1 AND voter_address = $2",
    [daoId, voterPublicKey],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });

      res.json({
        hasVoted: result.rows[0].count > 0,
        daoId,
        voterPublicKey,
      });
    },
  );
});

app.post("/prepare-create-proposal", async (req, res) => {
  try {
    const { daoId, title, description, votingDuration, userPublicKey } =
      req.body;

    if (!daoId || !title || !description || !votingDuration || !userPublicKey) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    console.log("Preparing create_proposal deploy for DAO:", daoId);

    const userPubKey = PublicKey.fromHex(userPublicKey);

    const argsMap = {
      dao_id: CLValue.newCLUint64(BigInt(daoId)),
      title: CLValue.newCLString(title),
      description: CLValue.newCLString(description),
      voting_duration: CLValue.newCLUint64(BigInt(votingDuration)),
    };

    const args = Args.fromMap(argsMap);
    const builder = new ContractCallBuilder();

    builder
      .byHash(DAO_CONTRACT_HASH.slice(5))
      .entryPoint("create_proposal")
      .from(userPubKey)
      .chainName(NETWORK_NAME)
      .payment(300_000_000_000)
      .ttl(1800000)
      .runtimeArgs(args);

    const transaction = builder.buildFor1_5();
    const deploy = transaction.getDeploy
      ? transaction.getDeploy()
      : transaction;

    let sessionArgsJson = [];
    let paymentArgsJson = [];

    if (deploy.session?.storedContractByHash?.args) {
      sessionArgsJson = serializeArgs(deploy.session.storedContractByHash.args);
    }

    if (deploy.payment?.moduleBytes?.args) {
      paymentArgsJson = serializeArgs(deploy.payment.moduleBytes.args);
    }

    const deployJson = {
      hash: deploy.hash?.value || deploy.hash,
      header: {
        account: deploy.header.account.value || deploy.header.account,
        timestamp: deploy.header.timestamp.toJSON
          ? deploy.header.timestamp.toJSON()
          : deploy.header.timestamp,
        ttl: deploy.header.ttl.toJSON
          ? deploy.header.ttl.toJSON()
          : deploy.header.ttl,
        gas_price: deploy.header.gasPrice,
        body_hash: deploy.header.bodyHash?.value || deploy.header.bodyHash,
        dependencies: [],
        chain_name: deploy.header.chainName,
      },
      payment: {
        ModuleBytes: {
          module_bytes: "",
          args: paymentArgsJson,
        },
      },
      session: {
        StoredContractByHash: {
          hash:
            deploy.session.storedContractByHash.hash?.value ||
            deploy.session.storedContractByHash.hash,
          entry_point: deploy.session.storedContractByHash.entryPoint,
          args: sessionArgsJson,
        },
      },
      approvals: [],
    };

    res.json({
      deployJson,
      message: "Deploy ready for user to sign with Casper Wallet",
    });
  } catch (err) {
    console.error("Prepare create proposal error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/verify-proposal/:daoId/:proposalId", async (req, res) => {
  try {
    const { daoId, proposalId } = req.params;

    console.log("Verifying proposal:", daoId, proposalId);

    const blockResponse = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "chain_get_block",
        params: [],
      }),
    });

    const blockResult = await blockResponse.json();
    const stateRootHash =
      blockResult.result?.block_with_signatures?.block?.Version2?.header
        ?.state_root_hash;

    const contractResponse = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "state_get_item",
        params: {
          state_root_hash: stateRootHash,
          key: DAO_CONTRACT_HASH,
          path: [],
        },
      }),
    });

    const contractResult = await contractResponse.json();
    const namedKeys =
      contractResult.result?.stored_value?.Contract?.named_keys || [];
    const eventKey = `event_proposal_created_${daoId}_${proposalId}`;
    const eventExists = namedKeys.some((k) => k.name === eventKey);
    const proposalsDict = namedKeys.find((k) => k.name === "proposals");
    const proposalKey = `${daoId}_${proposalId}`;

    let proposalDataExists = false;
    if (proposalsDict) {
      const proposalResponse = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "state_get_dictionary_item",
          params: {
            state_root_hash: stateRootHash,
            dictionary_identifier: {
              URef: {
                seed_uref: proposalsDict.key,
                dictionary_item_key: proposalKey,
              },
            },
          },
        }),
      });

      const proposalResult = await proposalResponse.json();
      proposalDataExists =
        !proposalResult.error && proposalResult.result?.stored_value;

      console.log(
        "Proposal data:",
        proposalResult.result?.stored_value?.CLValue?.parsed,
      );
    }

    res.json({
      daoId,
      proposalId,
      proposalKey,
      eventExists,
      proposalDataExists,
      exists: eventExists && proposalDataExists,
    });
  } catch (error) {
    console.error("Verify proposal error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/proposals/:daoId", async (req, res) => {
  try {
    const { daoId } = req.params;

    console.log("Fetching proposals for DAO:", daoId);

    const blockResponse = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "chain_get_block",
        params: [],
      }),
    });

    const blockResult = await blockResponse.json();
    const stateRootHash =
      blockResult.result?.block_with_signatures?.block?.Version2?.header
        ?.state_root_hash;
    const contractResponse = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "state_get_item",
        params: {
          state_root_hash: stateRootHash,
          key: DAO_CONTRACT_HASH,
          path: [],
        },
      }),
    });

    const contractResult = await contractResponse.json();
    const namedKeys =
      contractResult.result?.stored_value?.Contract?.named_keys || [];
    const metadataDict = namedKeys.find((k) => k.name === "proposal_metadata");
    const proposalsDict = namedKeys.find((k) => k.name === "proposals");
    const proposalEvents = namedKeys.filter((k) =>
      k.name.startsWith(`event_proposal_created_${daoId}_`),
    );

    console.log(
      `Found ${proposalEvents.length} proposal events for DAO ${daoId}`,
    );

    const proposals = [];

    for (const event of proposalEvents) {
      const parts = event.name
        .replace("event_proposal_created_", "")
        .split("_");
      const proposalId = parts[1];
      const proposalKey = `${daoId}_${proposalId}`;

      let title = `Proposal ${proposalId}`;
      let description = "No description available";
      let status = "active";
      let startTime = 0;
      let endTime = 0;
      let creator = "";

      try {
        if (metadataDict) {
          const metadataResponse = await fetch(RPC_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "state_get_dictionary_item",
              params: {
                state_root_hash: stateRootHash,
                dictionary_identifier: {
                  URef: {
                    seed_uref: metadataDict.key,
                    dictionary_item_key: proposalKey,
                  },
                },
              },
            }),
          });

          const metadataResult = await metadataResponse.json();
          const metadataValue =
            metadataResult.result?.stored_value?.CLValue?.parsed;

          if (metadataValue) {
            const metaParts = metadataValue.split("||");
            title = metaParts[0] || title;
            description = metaParts[1] || description;
          }
        }

        if (proposalsDict) {
          const proposalResponse = await fetch(RPC_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "state_get_dictionary_item",
              params: {
                state_root_hash: stateRootHash,
                dictionary_identifier: {
                  URef: {
                    seed_uref: proposalsDict.key,
                    dictionary_item_key: proposalKey,
                  },
                },
              },
            }),
          });

          const proposalResult = await proposalResponse.json();
          const proposalData =
            proposalResult.result?.stored_value?.CLValue?.parsed;

          if (proposalData) {
            const dataParts = proposalData.split("_");
            startTime = parseInt(dataParts[0]);
            endTime = parseInt(dataParts[1]);
            creator = dataParts[2];

            const now = Date.now();
            if (now < startTime) {
              status = "pending";
            } else if (now > endTime) {
              status = "ended";
            } else {
              status = "active";
            }
          }
        }
      } catch (err) {
        console.error(`Error reading proposal ${proposalId}:`, err.message);
      }

      proposals.push({
        dao_id: daoId,
        proposal_id: proposalId,
        title,
        description,
        status,
        start_time: startTime,
        end_time: endTime,
        creator,
      });
    }

    console.log(`Returning ${proposals.length} proposals with metadata`);
    res.json({ proposals });
  } catch (error) {
    console.error("Get proposals error:", error);
    res.status(500).json({ error: error.message, proposals: [] });
  }
});

app.get("/dao/:daoId", async (req, res) => {
  try {
    const { daoId } = req.params;
    pool.query(
      "SELECT * FROM daos WHERE dao_id = $1",
      [daoId],
      (err, result) => {
        if (err) {
          console.error("Error fetching DAO:", err);
          return res.status(500).json({ error: err.message });
        }

        if (!result.rows || result.rows.length === 0) {
          return res.status(404).json({ error: "DAO not found" });
        }

        res.json(result.rows[0]);
      },
    );
  } catch (error) {
    console.error("Get DAO error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/dao-stats/:daoId", async (req, res) => {
  try {
    const { daoId } = req.params;

    const memberResult = await pool.query(
      "SELECT COUNT(DISTINCT voter_address) as count FROM votes WHERE dao_id = $1",
      [daoId]
    );

    const voteResult = await pool.query(
      "SELECT COUNT(*) as count FROM votes WHERE dao_id = $1",
      [daoId]
    );

    const proposalResult = await pool.query(
      "SELECT COUNT(*) as count FROM proposals WHERE dao_id = $1",
      [daoId]
    );

    const activeResult = await pool.query(
      "SELECT COUNT(*) as count FROM proposals WHERE dao_id = $1 AND status = 'active'",
      [daoId]
    );

    res.json({
      memberCount: parseInt(memberResult.rows[0].count) || 0,
      totalVotes: parseInt(voteResult.rows[0].count) || 0,
      proposalCount: parseInt(proposalResult.rows[0].count) || 0,
      activeProposals: parseInt(activeResult.rows[0].count) || 0,
    });
  } catch (error) {
    console.error("Get DAO stats error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/dao/:daoId", (req, res) => {
  const { daoId } = req.params;

  pool.query("SELECT * FROM daos WHERE dao_id = $1", [daoId], (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ error: "DAO not found" });
    }

    res.json(result.rows[0]);
  });
});

app.post("/claim-faucet", async (req, res) => {
  try {
    const { recipientPublicKey } = req.body;

    if (!recipientPublicKey) {
      return res.status(400).json({ error: "Recipient public key required" });
    }

    console.log("Faucet claim request from:", recipientPublicKey);
    const lastClaim = faucetClaims.get(recipientPublicKey);
    const now = Date.now();

    if (lastClaim && now - lastClaim < FAUCET_COOLDOWN) {
      const remainingTime = FAUCET_COOLDOWN - (now - lastClaim);
      const remainingHours = Math.ceil(remainingTime / (1000 * 60 * 60));
      return res.status(429).json({
        error: `Please wait ${remainingHours} hours before claiming again`,
      });
    }

    const recipientPubKey = PublicKey.fromHex(recipientPublicKey);
    const accountHashObj = recipientPubKey.accountHash();
    const accountHashBytes = accountHashObj.hashBytes;

    console.log(
      "Account hash (hex):",
      Buffer.from(accountHashBytes).toString("hex"),
    );

    const keyBytes = new Uint8Array(33);
    keyBytes[0] = 0x00;
    keyBytes.set(accountHashBytes, 1);

    console.log("Sending tokens to correct account...");

    const argsMap = {
      recipient: CLValue.newCLByteArray(keyBytes),
      amount: CLValue.newCLUInt256(BigInt(FAUCET_AMOUNT)),
    };

    const args = Args.fromMap(argsMap);
    const builder = new ContractCallBuilder();

    builder
      .byHash(TOKEN_CONTRACT_HASH.slice(5))
      .entryPoint("transfer")
      .from(publicKey)
      .chainName(NETWORK_NAME)
      .payment(5_000_000_000)
      .ttl(1800000)
      .runtimeArgs(args);

    const transaction = builder.buildFor1_5();
    transaction.sign(privateKey);

    const deployHash = await putDeployViaRPC(transaction);

    console.log("Tokens sent!", deployHash);

    faucetClaims.set(recipientPublicKey, now);

    res.json({
      deployHash,
      amount: FAUCET_AMOUNT,
      recipient: recipientPublicKey,
      message: "Tokens sent! Check your wallet in ~1-2 minutes",
    });
  } catch (err) {
    console.error("Faucet error:", err);
    console.error("Stack:", err.stack);
    res.status(500).json({ error: err.message });
  }
});

app.post("/generate-summary", async (req, res) => {
  try {
    const { description } = req.body;

    if (!description || description.length < 20) {
      return res.status(400).json({
        error: "Description must be at least 20 characters",
      });
    }

    console.log("Generating AI summary for proposal...");

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content:
            "You are a DAO governance assistant. Summarize proposals clearly and concisely for voters. Focus on: 1) What is being proposed, 2) Why it matters, 3) Expected impact. Keep summaries under 100 words.",
        },
        {
          role: "user",
          content: `Summarize this DAO proposal for voters:\n\n${description}`,
        },
      ],
      max_tokens: 150,
      temperature: 0.7,
    });

    const summary = completion.choices[0].message.content.trim();

    console.log("AI summary generated successfully");
    res.json({ summary });
  } catch (error) {
    console.error("AI summary error:", error);
    res.status(500).json({
      error: "Failed to generate AI summary: " + error.message,
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(" API running on port", PORT);
  console.log("RPC URL:", RPC_URL);
  console.log("Public Key:", publicKey.toHex());
  console.log("Using NowNodes polling (no event stream)");
});
