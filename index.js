/**
 * Entry point — local: node index.js | Vercel: serverless handler
 */
const app = require('./app');
const PORT = process.env.PORT || 3847;

const handler = (req, res) => app(req, res);
module.exports = handler;

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`KidShield Cloud Server → http://0.0.0.0:${PORT}`);
  });
}
