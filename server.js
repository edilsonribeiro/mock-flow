const express = require("express");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const os = require("os");
const yaml = require("js-yaml");

const args = process.argv.slice(2);
const showLog = args.includes("--show-log");
const logRootDir = path.join(__dirname, "logs");

const configYamlPath = path.join(__dirname, "config.yaml");
const harsDir = path.join(__dirname, "hars");
const servers = new Map();
const activeHar = { name: null, apis: [] };
let globalWaitTime = 0;

// Variáveis de estado para seleção numerada
let expectingSelection = false;
let harFileList = [];

let hostMapGlobal = {};
function loadConfigOnce() {
  if (Object.keys(hostMapGlobal).length) return;
  if (!fs.existsSync(configYamlPath)) return;
  const config = yaml.load(fs.readFileSync(configYamlPath, "utf8"));
  globalWaitTime = config.waittime || 0;
  (config.hosts || []).forEach((entry) => {
    hostMapGlobal[`${entry.url}`] = {
      port: entry.port,
      removePrefix: entry.removePrefix || "",
    };
  });
}

loadConfigOnce();

function timestamp() {
  return new Date().toISOString();
}

function getHarLogPath(harName) {
  const harLogDir = path.join(logRootDir, harName.replace(/\.har$/i, ""));
  if (!fs.existsSync(harLogDir)) fs.mkdirSync(harLogDir, { recursive: true });
  return path.join(harLogDir, ".log");
}

function log(...messages) {
  const logMessage = `[${timestamp()}] ${messages.join(" ")}${os.EOL}`;
  if (activeHar.name)
    fs.appendFileSync(getHarLogPath(activeHar.name), logMessage);
  if (showLog) console.log(logMessage.trim());
}

function convertHarToApis(harFilePath) {
  if (!fs.existsSync(harFilePath)) return [];
  const harData = JSON.parse(fs.readFileSync(harFilePath, "utf8"));
  const entries = harData.log?.entries || [];
  const endpointsByPort = {};
  const hostMap = hostMapGlobal;

  entries.forEach((entry) => {
    const { method, url } = entry.request;
    const parsedUrl = new URL(url);
    const host = `${parsedUrl.protocol}//${parsedUrl.host}`;
    const hostEntry = hostMap[host];
    if (!hostEntry) return;

    const port = hostEntry.port;
    let p = parsedUrl.pathname.replace(/^\//, "");
    if (hostEntry.removePrefix && p.startsWith(hostEntry.removePrefix)) {
      p = p.slice(hostEntry.removePrefix.length);
      if (p.startsWith("/")) p = p.slice(1);
    }

    let body = {};
    try {
      body = JSON.parse(entry.response.content.text || "{}");
    } catch {
      body = { raw: entry.response.content.text || "" };
    }

    if (!endpointsByPort[port]) endpointsByPort[port] = [];
    endpointsByPort[port].push({
      method,
      path: p,
      response: { status: entry.response.status, body },
    });
  });

  return Object.entries(endpointsByPort).map(([port, endpoints]) => ({
    port: parseInt(port),
    endpoints,
  }));
}

function createServer(app, port) {
  const keyPath = path.join(__dirname, "certs", "key.pem");
  const certPath = path.join(__dirname, "certs", "cert.pem");

  let server;
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    server = https.createServer(
      {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      },
      app
    );
  } else {
    server = http.createServer(app);
  }

  server.listen(port, () => {
    log(`✅ Host na porta ${port} está online.`);
    console.log(
      `Servidor rodando na porta ${port}. Você pode testar os endpoints agora.`
    );
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log(
        `❌ Porta ${port} já está em uso. Verifique o config.yaml ou feche o serviço que está usando esta porta.`
      );
      console.log(
        `Falha ao iniciar na porta ${port}. Tente outro HAR ou libere a porta.`
      );
    } else {
      log(`❌ Erro ao iniciar servidor na porta ${port}:`, err.message);
      console.log(`Erro ao iniciar servidor: ${err.message}`);
    }
  });

  servers.set(port, server);
}

function stopServers(callback) {
  const ports = Array.from(servers.keys());
  if (ports.length === 0) {
    console.log("Nenhum servidor ativo para parar.");
    return callback();
  }
  let closed = 0;
  ports.forEach((port) => {
    servers.get(port).close(() => {
      closed++;
      console.log(`Servidor na porta ${port} foi desligado.`);
      if (closed === ports.length) {
        servers.clear();
        log("🔁 Todos os hosts foram desligados.");
        console.log(
          "Todos os servidores parados. Use `add` para iniciar outro HAR ou `help` para ver mais comandos."
        );
        callback();
      }
    });
  });
}

function loadHar(harName) {
  const filePath = path.join(harsDir, harName);
  if (!fs.existsSync(filePath)) {
    console.log(`Arquivo HAR não encontrado: ${harName}`);
    console.log(
      "Verifique o nome ou use `ls` para listar arquivos disponíveis."
    );
    return;
  }
  const apis = convertHarToApis(filePath);
  if (!apis.length) {
    log(`❌ Nenhum endpoint encontrado no arquivo HAR: ${harName}`);
    console.log("O HAR selecionado não possui endpoints. Tente outro HAR.");
    return;
  }
  activeHar.name = harName;
  activeHar.apis = apis;
  console.log(
    `Iniciando HAR: ${harName} com ${apis.length} portas configuradas...`
  );
  apis.forEach((api) => {
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: "50mb" }));
    log(`--- Endpoints da porta ${api.port} [${harName}] ---`);
    api.endpoints.forEach((endpoint) => {
      const { method, path: routePath, response } = endpoint;
      const methodLower = method.toLowerCase();
      const fullPath = "/" + routePath;

      app[methodLower](fullPath, (_, res) => {
        log(`${method} ${fullPath}`);
        setTimeout(() => {
          res
            .status(response.status)
            .set("Content-Type", "application/json")
            .send(JSON.stringify(response.body));
        }, globalWaitTime);
      });
    });

    createServer(app, api.port);
  });
  console.log(
    "HAR carregado. Use `status` para ver endpoints ativos ou `rm` para parar."
  );
}

function showStatus() {
  console.log(`\n🧩 HAR ativo: ${activeHar.name || "Nenhum"}`);
  const ports = Array.from(servers.keys());
  if (!ports.length) {
    console.log(
      "Nenhum endpoint ativo no momento. Use `add` para iniciar um HAR."
    );
    return;
  }
  ports.forEach((port) => {
    console.log(` - Porta ${port}: 🟢 Ativa`);
    const api = activeHar.apis.find((a) => a.port === port);
    if (api) {
      api.endpoints.forEach((e) => {
        console.log(`   • [${e.method}] /${e.path}`);
      });
    }
  });
  console.log(
    "Use `rm` para parar todos os endpoints ou `add` para mudar de HAR."
  );
}

function getHarFiles() {
  if (!fs.existsSync(harsDir)) return [];
  return fs.readdirSync(harsDir).filter((file) => file.endsWith(".har"));
}

function listHarFiles() {
  const files = getHarFiles();
  if (files.length === 0) {
    console.log("📂 Nenhum arquivo .har encontrado.");
    console.log("Coloque arquivos .har em /hars para usar a aplicação.");
    return;
  }
  console.log("\n📦 Arquivos HAR disponíveis:");
  files.forEach((file) => {
    const ativo = file === activeHar.name ? "🟢" : "⚪";
    console.log(`${ativo} ${file}`);
  });
  console.log(
    "Use `add <arquivo>` para iniciar um HAR ou `add` para seleção numerada."
  );
}

// Exibe lista numerada e prepara seleção
function listHarFilesNumbered() {
  const files = getHarFiles();
  if (files.length === 0) {
    console.log("📂 Nenhum arquivo .har encontrado.");
    console.log("Adicione arquivos .har em /hars e tente novamente.");
    expectingSelection = false;
    return;
  }
  console.log("\n📦 Selecione um arquivo HAR disponível:");
  files.forEach((file, index) => {
    console.log(` ${index + 1}. ${file}`);
  });
  console.log("Digite o número correspondente e pressione Enter.");
  harFileList = files;
  expectingSelection = true;
}

function showHelp() {
  console.log(`\n📘 Comandos disponíveis:`);
  console.log(
    ` ls             Lista todos os arquivos HAR disponíveis. Em seguida, use \`add <arquivo>\` ou apenas \`add\` para iniciar.`
  );
  console.log(
    ` add <arquivo>  Ativa o arquivo HAR e sobe seus endpoints. Ex: \`add exemplo.har\`.`
  );
  console.log(
    ` add            Mostra lista numerada de arquivos HAR para seleção. Em seguida, digite o número.`
  );
  console.log(
    ` rm             Remove o HAR ativo e desliga todos os endpoints. Após isso, use \`ls\` ou \`add\`.`
  );
  console.log(
    ` status         Mostra o HAR ativo e os endpoints em execução. Útil para confirmar se tudo está online.`
  );
  console.log(
    ` help           Mostra essa lista de comandos. Use sempre que estiver em dúvida.`
  );
  console.log(
    ` --show-log     Exibe os logs no console durante a execução. Use no início: \`node server.js --show-log\`.`
  );
  console.log(
    ` Ctrl + C       Encerra o serviço. Qualquer servidor ativo será parado automaticamente.`
  );
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (key) => {
  const input = key.trim();

  // Se estivermos aguardando a seleção numerada, interpretamos o próximo input como índice
  if (expectingSelection) {
    const choice = parseInt(input, 10);
    if (!isNaN(choice) && choice >= 1 && choice <= harFileList.length) {
      const selectedHar = harFileList[choice - 1];
      console.log(`Você selecionou: ${selectedHar}. Iniciando...`);
      stopServers(() => loadHar(selectedHar));
    } else {
      console.log("Seleção inválida. Tente novamente com um número válido.");
      listHarFilesNumbered();
    }
    expectingSelection = false;
    harFileList = [];
    return;
  }

  if (input === "status") {
    showStatus();
  } else if (input === "ls") {
    listHarFiles();
  } else if (input === "help") {
    showHelp();
  } else if (input === "add") {
    // Usuário digitou apenas "add": listar arquivos com número para seleção
    listHarFilesNumbered();
  } else if (input.startsWith("add ")) {
    // Usuário digitou "add <nome>"
    const name = input.replace("add ", "").trim();
    console.log(`Tentando carregar HAR: ${name}...`);
    stopServers(() => loadHar(name));
  } else if (input === "rm") {
    stopServers(() => {
      activeHar.name = null;
      activeHar.apis = [];
      console.log(
        "HAR removido. Você pode usar `ls` para listar HARs ou `add` para iniciar outro."
      );
      log("❌ Todos os endpoints foram removidos.");
    });
  } else {
    console.log(
      `Comando não reconhecido: \`${input}\`. Use \`help\` para ver os comandos disponíveis.`
    );
  }
});

// Exibe o menu de ajuda imediatamente ao iniciar a aplicação
showHelp();
