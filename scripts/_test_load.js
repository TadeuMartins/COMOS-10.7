try {
  require('./ai-api-shim.js');
} catch(e) {
  console.error('ERROR:', e.message);
  console.error(e.stack);
}
