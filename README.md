# 🧪 Mock API com HAR e Node.js

Este projeto é uma ferramenta de simulação de APIs (mock server), que utiliza arquivos `.har` exportados do navegador para gerar endpoints estáticos de forma automática. Ideal para desenvolvedores frontend testarem suas aplicações mesmo sem uma API funcional.

---

## 📦 Funcionalidades

* Leitura automática de arquivos HAR.
* Cria endpoints GET, POST, PUT, DELETE com base no HAR.
* Endpoints são expostos nas portas configuradas via `config.yaml`.
* Delay configurável nas respostas com `waittime`.
* Suporte a HTTPS com certificados.
* Logs separados por HAR na pasta `logs/`.
* CLI simples para gerenciamento dinâmico dos mocks.

---

## 🚀 Como usar

### 1. Instale o Node.js

Certifique-se de ter o Node.js instalado. Versões recentes (v18+) recomendadas.

### 2. Crie o arquivo `config.yaml`

```yaml
waittime: 1000

hosts:
  - url: https://api.exemplo.com
    port: 44385
    removePrefix: v1/api
  - url: http://localhost:3000
    port: 3000
```plaintext

### 3. Coloque os arquivos `.har` na pasta `hars/`

### 4. Execute o servidor

```bash
node server.js --show-log
```plaintext

---

## 🖥️ Comandos disponíveis (CLI)

Dentro do terminal:

```bash
help               # Mostra os comandos disponíveis
ls                 # Lista arquivos HAR disponíveis
add arquivo.har    # Ativa um arquivo HAR
rm                 # Remove o HAR ativo
status             # Mostra os endpoints ativos
```plaintext

---

## 🧪 Exemplo de uso

```bash
add simulador.har
status
rm
```

---

## 📁 Estrutura de Diretórios

```text
├── server.js         # Arquivo principal
├── config.yaml       # Configuração global
├── hars/             # Pasta com arquivos HAR
├── logs/             # Logs separados por HAR
├── certs/            # Certificados TLS opcionais
```

---

## 🔐 HTTPS (Opcional)

Coloque os arquivos `key.pem` e `cert.pem` na pasta `certs/` para habilitar HTTPS automaticamente.

---

## 🛠️ Sugestões de melhorias futuras

* Interface web para gerenciar mocks visualmente
* Cache e mock por tempo de expiração
* Geração automática de OpenAPI
* Testes automatizados com Jest ou Mocha

---

## 📝 Licença

MIT
