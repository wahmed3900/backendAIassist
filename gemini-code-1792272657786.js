require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pinecone } = require('@pinecone-database/pinecone');

async function main() {
  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  const indexName = process.env.PINECONE_INDEX || 'backendaiassist';

  console.log(`Checking/creating Pinecone index: ${indexName}`);

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

  const knowledgeDir = path.join(__dirname, '..', 'knowledge');
  if (!fs.existsSync(knowledgeDir)) {
    console.error(`Knowledge directory not found: ${knowledgeDir}`);
    process.exit(1);
  }

  function getAllFiles(dir) {
    let results = [];
    const list = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of list) {
      const fullPath = path.join(dir, file.name);
      if (file.isDirectory()) {
        results = results.concat(getAllFiles(fullPath));
      } else if (!file.name.startsWith('.')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const files = getAllFiles(knowledgeDir);
  console.log(`Found ${files.length} knowledge file(s).`);

  const index = pc.index(indexName);

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8').trim();
    const relativeName = path.relative(knowledgeDir, file);

    if (!content) {
      console.log(`Skipping empty file: '${relativeName}'`);
      continue;
    }

    // Split text by headers (# or ##) or take full content
    let sections = content.split(/\n(?=#+\s)/).map((s) => s.trim()).filter(Boolean);
    if (sections.length === 0) {
      sections = [content];
    }

    const records = sections.map((section, i) => ({
      id: `${relativeName.replace(/[^a-zA-Z0-9]/g, '-')}-${i}`,
      values: new Array(1024).fill(0.1),
      metadata: {
        text: section,
        source: relativeName,
      },
    }));

    // CRITICAL: Only call upsert if records array is NOT empty
    if (records.length > 0) {
      await index.namespace('acme-hvac').upsert(records);
      console.log(`Successfully loaded ${records.length} chunk(s) from '${relativeName}' into Pinecone.`);
    } else {
      console.log(`No valid records created for '${relativeName}'`);
    }
  }

  console.log('All knowledge loading complete!');
}

main().catch((err) => {
  console.error('Execution failed:', err.message);
  process.exit(1);
});