import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createDocument } from '../src/services/rag/ingest';
import { logger } from '../src/lib/logger';

// Seed a knowledge document from a local text/markdown file.
//   npm run seed -- ./faq.md "Shipping FAQ"
async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    process.stderr.write('Usage: npm run seed -- <path-to-file> [title]\n');
    process.exit(1);
  }
  const title = process.argv[3] ?? basename(filePath).replace(/\.[^.]+$/, '');
  const content = await readFile(filePath, 'utf8');

  const result = await createDocument({ title, content, sourceType: 'seed' });
  logger.info(result, 'seeded knowledge document');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'seed failed');
  process.exit(1);
});
