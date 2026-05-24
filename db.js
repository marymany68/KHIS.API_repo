require('dotenv').config();
const { Client } = require('pg');
const axios = require('axios');

// ── PostgreSQL client setup ──────────────────────────────────────────────────
const client = new Client({
  user:     process.env.PG_USER,
  host:     process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port:     parseInt(process.env.PG_PORT) || 5432,
});

// ── DB connection with retry logic ──────────────────────────────────────────
async function connectWithRetry(retries = 5, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await client.connect();
      console.log("✅ Connected to PostgreSQL successfully!");
      return;
    } catch (err) {
      console.error(`❌ Connection attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt === retries) throw new Error("Could not connect to PostgreSQL after multiple attempts.");
      console.log(`   Retrying in ${delayMs / 1000}s...`);
      await new Promise(res => setTimeout(res, delayMs));
    }
  }
}

// ── Create table if it doesn't exist ────────────────────────────────────────
async function ensureTable() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS mortality_records (
      id          SERIAL PRIMARY KEY,
      org_unit    TEXT NOT NULL,
      indicator   TEXT NOT NULL,
      period      TEXT NOT NULL,
      deaths      INTEGER,
      inserted_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (org_unit, indicator, period)
    )
  `);
  console.log("✅ Table 'mortality_records' is ready.");
}

// ── Fetch data from DHIS2 API ────────────────────────────────────────────────
async function fetchDHIS2Data() {
  console.log("⏳ Fetching data from HIS Kenya API...");
  const response = await axios.get('https://hiskenya.dha.go.ke/api/analytics.json', {
    auth: {
      username: process.env.DHIS2_USERNAME,
      password: process.env.DHIS2_PASSWORD,
    },
    params: {
      dimension: [
        'dx:kvKvG35IPmd;dPRCstLVkZu',
        'ou:HfVjCurKxh2;LEVEL-JwTgQwgnl8h',
        'pe:LAST_12_MONTHS',
      ],
      showHierarchy:          false,
      hierarchyMeta:          false,
      includeMetadataDetails: true,
      includeNumDen:          true,
      skipRounding:           false,
      completedOnly:          false,
      outputIdScheme:         'UID',
    },
    timeout: 30000, // 30 second timeout
  });

  console.log(`✅ API responded with status ${response.status}`);
  console.log(`   Total rows fetched: ${response.data.rows.length}`);
  return response.data;
}

// ── Insert rows into PostgreSQL ──────────────────────────────────────────────
async function insertRows(data) {
  const { rows, headers, metaData } = data;
  const metaItems = metaData.items;

  // Dynamically resolve column positions from headers
  const dxIndex    = headers.findIndex(h => h.name === 'dx');
  const ouIndex    = headers.findIndex(h => h.name === 'ou');
  const peIndex    = headers.findIndex(h => h.name === 'pe');
  const valueIndex = headers.findIndex(h => h.name === 'value');

  console.log(`   Column mapping → dx:${dxIndex}, ou:${ouIndex}, pe:${peIndex}, value:${valueIndex}`);

  let inserted = 0;
  let skipped  = 0;
  let failed   = 0;

  for (const row of rows) {
    const indicatorUID  = row[dxIndex];
    const orgUnitUID    = row[ouIndex];
    const periodCode    = row[peIndex];
    const value         = row[valueIndex];

    const indicatorName = metaItems[indicatorUID]?.name || indicatorUID;
    const orgUnitName   = metaItems[orgUnitUID]?.name   || orgUnitUID;
    const periodLabel   = metaItems[periodCode]?.name   || periodCode;
    const deaths        = parseInt(parseFloat(value));

    try {
      // ON CONFLICT skips duplicate (org_unit + indicator + period) combos
      const result = await client.query(
        `INSERT INTO mortality_records (org_unit, indicator, period, deaths)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_unit, indicator, period) DO NOTHING`,
        [orgUnitName, indicatorName, periodLabel, deaths]
      );
      result.rowCount > 0 ? inserted++ : skipped++;
    } catch (err) {
      console.error("   Insert failed:", err.message);
      console.error("   Row:", [orgUnitName, indicatorName, periodLabel, deaths]);
      failed++;
    }
  }

  return { inserted, skipped, failed };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  try {
    // 1. Connect to DB
    await connectWithRetry();

    // 2. Confirm correct database
    const dbCheck = await client.query('SELECT current_database()');
    console.log(`   Active database: ${dbCheck.rows[0].current_database}`);

    // 3. Ensure table exists
    await ensureTable();

    // 4. Fetch from API
    const data = await fetchDHIS2Data();

    // 5. Insert rows
    console.log("⏳ Inserting records into PostgreSQL...");
    const { inserted, skipped, failed } = await insertRows(data);

    // 6. Summary
    console.log("\n── Summary ──────────────────────────────");
    console.log(`   ✅ Inserted : ${inserted}`);
    console.log(`   ⏭️  Skipped  : ${skipped} (duplicates)`);
    console.log(`   ❌ Failed   : ${failed}`);

    // 7. Final count
    const countCheck = await client.query('SELECT COUNT(*) FROM mortality_records');
    console.log(`   📊 Total records in table: ${countCheck.rows[0].count}`);
    console.log("─────────────────────────────────────────\n");

  } catch (err) {
    console.error("\n🚨 Fatal error:", err.message);
    process.exit(1);
  } finally {
    await client.end();
    console.log("🔌 PostgreSQL connection closed.");
  }
}

run();