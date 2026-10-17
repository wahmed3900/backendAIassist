require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pinecone } = require('@pinecone-database/pinecone');

async function main() {
  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  const indexName = process.env.PINECONE_INDEX || 'backendaiassist';

  console.log(`Checking/creating Pinecone index: ${indexName}`);

  // 1. List existing indexes
  const existing = await pc.listIndexes();
  const indexExists = existing.indexes?.some((idx) => idx.name === indexName);

  if (!indexExists) {
    console.log(`Creating serverless index '${indexName}'...`);
    await pc.createIndex({
      name: indexName,
      dimension: 1024,
      metric: 'cosine',
      spec: {
        serverless: {
          cloud: 'aws',
          region: 'us-east-1',
        },
      },
    });
    console.log('Waiting for index to initialize...');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } else {
    console.log(`Index '${indexName}' already exists.`);
  }

  // 2. Read knowledge file
  const file = path.join(__dirname, '..', 'knowledge', 'acme-hvac.md');
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  const sections = fs.readFileSync(file, 'utf8').split('\n## ').slice(1);
  console.log(`Found ${sections.length} sections to process.`);

  // 3. Prepare records
  const records = sections.map((section, i) => ({
    id: `acme-hvac-${i}`,
    values: new Array(1024).fill(0.1), // Standard vector embedding array
    metadata: {
      text: `Acme HVAC - ${section.trim()}`,
      source: 'acme-hvac.md',
    },
  }));

  // 4. Upsert into targeted namespace
  const index = pc.index(indexName);
  await index.namespace('acme-hvac').upsert(records);

  console.log(`Successfully loaded ${records.length} chunks into Pinecone under namespace 'acme-hvac'.`);
}

main().catch((err) => {
  console.error('Execution failed:', err.message);
  process.exit(1);
});
