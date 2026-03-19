require('dotenv').config();

const { main } = require('./src/main');

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exit(typeof exitCode === 'number' ? exitCode : 0);
  })
  .catch((error) => {
    console.error('❌ Unhandled error:', error.message);
    console.error(error.stack);
    process.exit(1);
  });
