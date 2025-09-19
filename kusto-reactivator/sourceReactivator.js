import { createRequire } from "module";
const require = createRequire(import.meta.url);

const KustoClient = require("azure-kusto-data").Client;
const KustoConnectionStringBuilder = require("azure-kusto-data").KustoConnectionStringBuilder;
import { DaprClient } from '@dapr/dapr';
import { DefaultAzureCredential } from "@azure/identity"; 
const cors = require('cors');
const bodyParser = require('body-parser');
const express = require('express');

const clusterConectionString = process.env["KUSTO_URI"];
const database = process.env["KUSTO_DATABASE"];
const table = process.env["KUSTO_TABLE"];
const sourceId = process.env["SOURCE_ID"];
const pubsubName = process.env["PUBSUB"] ?? "drasi-pubsub";
const subscriberStore = process.env["STATE_STORE"] ?? "drasi-state";
const pollingInterval = process.env["POLLING_INTERVAL"] ?? 10000; 
const user_managed_identity = process.env["USER_MANAGED_IDENTITY"];
const primaryKey = process.env["PRIMARY_KEY"];
const kustoQuery = process.env["KUSTO_QUERY"];

let daprClient = new DaprClient();

const credential = new DefaultAzureCredential({managedIdentityClientId: user_managed_identity});
const kcsb = KustoConnectionStringBuilder.withTokenCredential(clusterConectionString, credential);
const app = express();



let currentCursor = "";
let pollingStarted = false;

function startPolling() {
  if (pollingStarted) return;
  pollingStarted = true;

  console.log("Starting data retrieval polling...");
  setInterval(async () => {
    let result = await getKustoData(kcsb);
    let events = JSON.parse(result.primaryResults[0])["data"];
    if (events.length > 0) {
      for (let event of events) {
        let changes = buildChange(event);
        await daprClient.pubsub.publish(pubsubName, sourceId + "-change", [changes]);
      }
    }
  }, pollingInterval);
}

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post('/acquire', async (req, res) => {
  try {
    console.log('/acquire endpoint called');
    const input = req.body;
    console.log('Request body:', JSON.stringify(input, null, 2));

    const kustoClient = new KustoClient(kcsb);
    let results = await kustoClient.execute(database, kustoQuery);
    console.log("initial bootstrap query executed");
    let result = JSON.parse(results.primaryResults[0])["data"];
    console.log('Formatted results:', result.length, 'rows');

    const body = { nodes: [], rels: [] };
    for (let label of input.nodeLabels) {
      for (let event of result) {
        //Travese through all events
        let node = mapRowToNode(event, label, "kusto", primaryKey);
        body.nodes.push(node);
      }
    }
    kustoClient.close();
    console.log('Sending response with', body.nodes.length, 'nodes');
    res.status(200).json(body);

    // Start polling after first acquire completes
    startPolling();
  } catch (error) {
    console.error("Error in /acquire:", error);
    res.status(500).json({ error: error.message });
  }
});

let port = 80;
app.listen(port, () => {
  console.log('listening...');
});

// Polling will start after first /acquire call


function mapRowToNode(row,label, idPrefix, idField) {
  return {
    id: idPrefix + "." + row[idField],
    labels: [label],
    properties: row,
  }
}


function buildChange(result) {
  var output = {};
  output['op'] = 'i'; // insert operation

  var debPayload = {};
  output['payload'] = debPayload;

  var debSource = {};
  debPayload['source'] = debSource;
  debSource['db'] = sourceId;
  debSource['table'] = 'node';
  debSource['lsn'] = Math.floor(Date.now() / 1000); // Use timestamp as sequence
  debSource['ts_ns'] = Date.now() * 1_000_000; // Convert to nanoseconds

  var debBefore = {};
  debPayload['before'] = debBefore;

  var debAfter = {};
  debPayload['after'] = debAfter;
  debAfter['id'] = table + "." + result[primaryKey];
  debAfter['labels'] = [table];
  debAfter['properties'] = result;

  output['reactivatorStart_ns'] = Date.now() * 1_000_000;
  output['reactivatorEnd_ns'] = Date.now() * 1_000_000;

  return output;
}

async function getKustoData(kcsb) {
  const kustoClient = new KustoClient(kcsb);
  let results;
  try {
    currentCursor = await daprClient.state.get(subscriberStore, "database_cursor"); //Retrieving cursor from dapr state store
    results = await kustoClient.execute(database, `${kustoQuery} | where cursor_after('${currentCursor}')`);
    currentCursor = await retrieveCursor(kustoClient)
  } catch (error) {
      console.log(error);
  }
  kustoClient.close();
  return results;
}


async function retrieveCursor(kustoClient) {
  let cursor = "";
  cursor = await daprClient.state.get(subscriberStore, "database_cursor");
  console.log("cursor from state store: " + cursor);
  
  //newCursor will be stored in dapr state store
  let newCursor = "";
  const results = await kustoClient.execute(database, `print(current_cursor())`);
  newCursor = JSON.parse(results.primaryResults[0])["data"][0]["print_0"];


  //if cursor is not found in state store, retrieve it from kusto
  
  if (cursor == null || cursor == "") {
    const results = await kustoClient.execute(database, `print(current_cursor())`);
    cursor = JSON.parse(results.primaryResults[0])["data"][0]["print_0"];
    newCursor = cursor;
  }

  //Storing cursor to dapr state store
  await daprClient.state.save(subscriberStore, [
    {
      key: "database_cursor",
      value: newCursor
    }
  ]);
  return cursor;
}
