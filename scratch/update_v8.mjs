import fs from 'fs';

const filePath = 'cron/v8/viral_magnet_generator.js';
let code = fs.readFileSync(filePath, 'utf8');

const target = "    'the pull request that is 4,000 lines long and titled \"minor cleanup\"',";
const addition = `    'the pull request that is 4,000 lines long and titled "minor cleanup"',
    'spending 45 minutes prompt engineering an agent to fix a bug you could have solved in 30 seconds',
    'when an AI code review bot writes three paragraphs about variable naming but misses a critical race condition',
    'paying $250 a month in LLM tokens just to build a CRUD app with 4 users',
    'migrating a simple modular monolith into 14 microservices and spending the sprint debugging network latency',`;

if (code.includes(target)) {
  code = code.replace(target, addition);
  fs.writeFileSync(filePath, code, 'utf8');
  console.log('Successfully updated seeds in viral_magnet_generator.js');
} else {
  console.log('Target not found in', filePath);
}
