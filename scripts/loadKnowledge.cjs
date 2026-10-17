require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pinecone } = require('@pinecone-database/pinecone');

async function main() {
  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  const indexName = process.env.PINECONE_INDEX || 'backendaiassist';

  console.log(`Checking/creating Pinecone index: ${indexName}`);
  
  // Correct method for creating an index with an embedded model in the JS/TS SDK
  const indexModel = await pc.indexes.createForModel({
    name: indexName,
    cloud: 'aws',
    region: 'us-east-1',
    embed: { 
      model: 'multilingual-e5-large', 
      fieldMap: { text: 'chunk_text' } 
    },
    waitUntilReady: true,
  });

  const file = path.join(__dirname, '..', 'knowledge', 'acme-hvac.md');
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  const sections = fs.readFileSync(file, 'utf8').split('\n## ').slice(1);
  const records = sections.map((section, i) => ({
    id: `acme-hvac-${i}`,
    chunk_text: `Acme HVAC - ${section.trim()}`,
  }));

  const index = pc.index({ host: indexModel.host, namespace: 'acme-hvac' });
  await index.upsertRecords({ records });

  console.log(`Successfully loaded ${records.length} chunks into Pinecone.`);
}

main().catch((err) => console.error('Error:', err.message));
