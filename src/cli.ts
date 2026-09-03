import { runPreflight } from './preflight/index.ts';
import { reportBrands } from './domain/report.ts';
import { ConfigError } from './config.ts';

const command = process.argv[2];

try {
  switch (command) {
    case 'preflight':
      process.exitCode = await runPreflight();
      break;
    case 'brands':
      process.exitCode = reportBrands();
      break;
    default:
      console.log('usage: npm run preflight | npm run brands');
      process.exitCode = 1;
  }
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`\n${e.message}\n`);
    process.exitCode = 1;
  } else {
    throw e;
  }
}
