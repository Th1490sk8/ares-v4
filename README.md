# 🚀 ARES v5 - NEURAL LINK

ARES (Atmospheric Real-time Embedded System) é uma solução avançada de monitoramento ambiental de precisão construída com **Rust (ESP-IDF)** e **Node.js**. A versão 5 introduz o **"Neural Link"**, estabelecendo uma ponte de comunicação assíncrona (Uplink) entre o microcontrolador ESP32-S3 e um servidor base ("Matriz") para persistência em banco de dados, além de um painel web com temática Cyberpunk rodando direto na placa.

## 🛠️ Arquitetura e Funcionalidades

* **Uplink Neural (Backend Node.js):** O ESP32 envia ativamente leituras (HTTP POST) para um servidor Node.js local que processa e armazena os dados em banco de dados.
* **Processamento Dual-Core (Multithreading):** Divisão inteligente de carga. A leitura de sensores e atualização do display OLED rodam no Core 1, enquanto o Wi-Fi, servidor Web local e UPLINK operam no Core 0.
* **Interface Web Cyberpunk:** Dashboard dinâmico servido diretamente pelo ESP32 (`/`), construído com Chart.js para visualização de tendências em tempo real.
* **Monitoramento de Alta Precisão:** Implementação de filtro de média móvel para suavização de ruídos nos dados do sensor de temperatura e umidade.
* **Persistência NVS:** Salva o estado de atuadores (como o LED de override) na memória não-volátil do ESP32, restaurando-o automaticamente após quedas de energia.
* **Display Local:** Interface gráfica via SSD1306 (I2C) com feedback visual imediato do status da máquina e alertas térmicos.

## 🔌 Hardware Necessário

| Componente | Pino (GPIO) | Função |
| :--- | :--- | :--- |
| **ESP32-S3** | - | Microcontrolador Principal |
| **Sensor DHT11** | GPIO 5 | Captura de Temperatura/Umidade |
| **Display OLED I2C** | SDA (1), SCL (2) | Interface Visual Local |
| **LED de Status** | GPIO 4 | Atuador de Comando (Override) |

## 🚀 Como Executar

O ecossistema agora é composto por duas partes: o Servidor Base (Matriz) e o Microcontrolador (ARES).

### 1. Iniciando a Matriz (Servidor Node.js)
O servidor precisa estar online para receber o Uplink de dados do ESP32.
```bash
# Instale as dependências do Node (se houver pacote no package.json)
npm install

# Inicie o servidor (Ele irá escutar na porta 3000 em toda a rede local - 0.0.0.0)
node server.js