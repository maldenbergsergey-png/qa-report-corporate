const http = require('node:http');
exports.freePort = async () => {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
};
exports.waitForStartup = (app, origin) => new Promise((resolve, reject) => {
  let output = ''; let errors = '';
  const timer = setTimeout(() => reject(new Error('Test server startup timed out: ' + errors)), 5000);
  app.once('error', error => { clearTimeout(timer); reject(error); });
  app.once('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited ${code}: ${errors}`)); });
  app.stderr.on('data', chunk => errors += chunk);
  app.stdout.on('data', chunk => {
    output += chunk;
    if (output.includes(`QA Report: ${origin}`)) { clearTimeout(timer); resolve(); }
  });
});
