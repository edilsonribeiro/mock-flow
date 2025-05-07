const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const os = require('os');
const yaml = require('js-yaml');

const args = process.argv.slice(2);
const showLog = args.includes('--show-log');
const logRootDir = path.join(__dirname, 'logs');

const configYamlPath = path.join(__dirname, 'config.yaml');
const harsDir = path.join(__dirname, 'hars');
const servers = new Map();
const activeHar = { name: null, apis: [] };
let globalWaitTime = 0;

function timestamp() {
  return new Date().toISOString();
}

function getHarLogPath(harName) {
  const harLogDir = path.join(logRootDir, harName.replace(/\.har$/i, ''));
  if (!fs.existsSync(harLogDir)) fs.mkdirSync(harLogDir, { recursive: true });
  return path.join(harLogDir, '.log');
}

function log(...messages) {
  const logMessage = `[${timestamp()}] ${messages.join(' ')}${os.EOL}`;
  if (activeHar.name) fs.appendFileSync(getHarLogPath(activeHar.name), logMessage);
  if (showLog) console.log(logMessage.trim());
}

function parseGlobalConfig() {
  if (!fs.existsSync(configYamlPath)) return {};
  const config = yaml.load(fs.readFileSync(configYamlPath, 'utf8'));
  globalWaitTime = config.waittime || 0;
  const hosts = {};
  (config.hosts || []).forEach(entry => {
    hosts[entry.url] = {
      port: entry.port,
      removePrefix: entry.removePrefix || ''
    };
  });
  return hosts;
}

function convertHarToApis(harFilePath) {
  if (!fs.existsSync(harFilePath)) return [];
  const harData = JSON.parse(fs.readFileSync(harFilePath, 'utf8'));
  const entries = harData.log?.entries || [];
  const endpointsByPort = {};
  const hostMap = parseGlobalConfig();

  entries.forEach(entry => {
    const { method, url } = entry.request;
    const parsedUrl = new URL(url);
    const host = `${parsedUrl.protocol}//${parsedUrl.host}`;
    const hostEntry = hostMap[host];
    if (!hostEntry) return;

    const port = hostEntry.port;
    let path = parsedUrl.pathname.replace(/^\//, '');
    if (hostEntry.removePrefix && path.startsWith(hostEntry.removePrefix)) {
      path = path.slice(hostEntry.removePrefix.length);
      if (path.startsWith('/')) path = path.slice(1);
    }

    let body = {};
    try {
      body = JSON.parse(entry.response.content.text || '{}');
    } catch {
      body = { raw: entry.response.content.text || '' };
    }

    if (!endpointsByPort[port]) endpointsByPort[port] = [];
    endpointsByPort[port].push({
      method,
      path,
      response: { status: entry.response.status, body }
    });
  });

  return Object.entries(endpointsByPort).map(([port, endpoints]) => ({
    port: parseInt(port),
    endpoints
  }));
}

function createServer(app, port) {
  const keyPath = path.join(__dirname, 'certs', 'key.pem');
  const certPath = path.join(__dirname, 'certs', 'cert.pem');

  let server;
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    server = https.createServer({
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    }, app);
  } else {
    server = http.createServer(app);
  }

  server.listen(port, () => {
    log(`✅ Host na porta ${port} está online.`);
  });
  
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`❌ Porta ${port} já está em uso. Verifique o config.yaml ou feche o serviço que está usando esta porta.`);
    } else {
      log(`❌ Erro ao iniciar servidor na porta ${port}:`, err.message);
    }
  });

  servers.set(port, server);
}

function stopServers(callback) {
  const ports = Array.from(servers.keys());
  if (ports.length === 0) return callback();
  let closed = 0;
  ports.forEach(port => {
    servers.get(port).close(() => {
      closed++;
      if (closed === ports.length) {
        servers.clear();
        log('🔁 Todos os hosts foram desligados.');
        callback();
      }
    });
  });
}

function loadHar(harName) {
  const filePath = path.join(harsDir, harName);
  const apis = convertHarToApis(filePath);
  if (!apis.length) return log(`❌ Nenhum endpoint encontrado no arquivo HAR: ${harName}`);
  activeHar.name = harName;
  activeHar.apis = apis;
  apis.forEach(api => {
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '50mb' }));
    log(`--- Endpoints da porta ${api.port} [${harName}] ---`);
    api.endpoints.forEach(endpoint => {
      const { method, path: routePath, response } = endpoint;
      const methodLower = method.toLowerCase();
      const fullPath = '/' + routePath;

      app[methodLower](fullPath, (_, res) => {
        log(`${method} ${fullPath}`);
        setTimeout(() => {
          res.status(response.status).set('Content-Type', 'application/json').send(JSON.stringify(response.body));
        }, globalWaitTime);
      });
    });

    createServer(app, api.port);
  });
}

function showStatus() {
  console.log(`\n🧩 HAR ativo: ${activeHar.name || 'Nenhum'}`);
  const ports = Array.from(servers.keys());
  ports.forEach(port => {
    console.log(` - Porta ${port}: 🟢 Ativa`);
    const api = activeHar.apis.find(a => a.port === port);
    if (api) {
      api.endpoints.forEach(e => {
        console.log(`   • [${e.method}] /${e.path}`);
      });
    }
  });
}

function listHarFiles() {
  if (!fs.existsSync(harsDir)) return console.log('📁 Pasta de HARs não encontrada.');
  const files = fs.readdirSync(harsDir).filter(file => file.endsWith('.har'));
  if (files.length === 0) return console.log('📂 Nenhum arquivo .har encontrado.');
  console.log('\n📦 Arquivos HAR disponíveis:');
  files.forEach(file => {
    const ativo = file === activeHar.name ? '🟢' : '⚪';
    console.log(`${ativo} ${file}`)});
}

function showHelp() {
  console.log(`\n📘 Comandos disponíveis:`);
  console.log(` ls             Lista todos os arquivos HAR disponíveis.`);
  console.log(` add <arquivo>  Ativa o arquivo HAR e sobe seus endpoints.`);
  console.log(` rm             Remove o arquivo HAR ativo e desliga todos os endpoints.`);
  console.log(` status         Mostra o HAR ativo e os endpoints em execução.`);
  console.log(` help           Mostra essa lista de comandos.`);
  console.log(` --show-log     Exibe os logs no console durante a execução.`);
  console.log(` Ctrl + C       Encerra o serviço.`);
}  

process.stdin.setEncoding('utf8');
process.stdin.on('data', key => {
  const input = key.trim();
  if (input === 'status') {
    showStatus();
  } else if (input === 'ls') {
    listHarFiles();
  } else if (input === 'help') {
    showHelp();
  } else if (input.startsWith('add ')) {
    const name = input.replace('add ', '').trim();
    stopServers(() => loadHar(name));
  } else if (input === 'rm') {
    stopServers(() => {
      activeHar.name = null;
      activeHar.apis = [];
      log('❌ Todos os endpoints foram removidos.');
    });
  }
});
