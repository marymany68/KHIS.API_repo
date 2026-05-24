const { Client } = require('pg');
const axios = require('axios');

const client = new Client({
  user: 'postgres',
  host: 'localhost',
  database: 'LWALADB',
  password: '1234',
  port: 5432,
});

async function run() {
  await client.connect();
  console.log("Connected to PostgreSQL successfully!");

  const response = await axios.get('https://hiskenya.dha.go.ke/api/analytics.json', {
    auth: {
      username: 'Many',
      password: 'Joseph@2014'
    },
    params: {
      dimension: [
        'dx:kvKvG35IPmd;dPRCstLVkZu',
        'ou:HfVjCurKxh2;LEVEL-JwTgQwgnl8h',
        'pe:LAST_12_MONTHS'
      ],
      showHierarchy: false,
      hierarchyMeta: false,
      includeMetadataDetails: true,
      includeNumDen: true,
      skipRounding: false,
      completedOnly: false,
      outputIdScheme: 'UID'
    }
  });

  const rows = response.data.rows;
  const metaItems = response.data.metaData.items;
  const headers = response.data.headers;

  console.log("API status:", response.status);
  console.log("Total rows from API:", rows.length);
  console.log("Headers:", headers.map(h => h.name));

  // Dynamically resolve column positions
  const dxIndex    = headers.findIndex(h => h.name === 'dx');
  const ouIndex    = headers.findIndex(h => h.name === 'ou');
  const peIndex    = headers.findIndex(h => h.name === 'pe');
  const valueIndex = headers.findIndex(h => h.name === 'value');

  console.log(`Column order → dx:${dxIndex}, ou:${ouIndex}, pe:${peIndex}, value:${valueIndex}`);

  // Verify we are in the correct database
  const dbCheck = await client.query('SELECT current_database()');
  console.log("Connected to database:", dbCheck.rows[0].current_database);

  let inserted = 0;
  let failed = 0;

  for (const row of rows) {
    const indicatorUID = row[dxIndex];
    const orgUnitUID   = row[ouIndex];
    const periodCode   = row[peIndex];
    const value        = row[valueIndex];

    const indicatorName = metaItems[indicatorUID]?.name || indicatorUID;
    const orgUnitName   = metaItems[orgUnitUID]?.name   || orgUnitUID;
    const periodLabel   = metaItems[periodCode]?.name   || periodCode;
    const deaths        = parseInt(parseFloat(value));

    try {
      await client.query(
        'INSERT INTO mortality_records (org_unit, indicator, period, deaths) VALUES ($1, $2, $3, $4)',
        [orgUnitName, indicatorName, periodLabel, deaths]
      );
      inserted++;
    } catch (err) {
      console.error("Insert failed:", err.message);
      console.error("Row was:", [orgUnitName, indicatorName, periodLabel, deaths]);
      failed++;
    }
  }

  console.log(`\nDone — Inserted: ${inserted} | Failed: ${failed}`);

  // Final verification
  const countCheck = await client.query('SELECT COUNT(*) FROM mortality_records');
  console.log("Total records now in table:", countCheck.rows[0].count);

  await client.end();
}

run().catch(err => console.error("Fatal error:", err));